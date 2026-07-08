import { Hono } from "hono"
import { Log } from "../log"
import {
  isAgentHarnessAccess,
  isAgentHarnessId,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
  type HarnessConnection,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import type { WorkspaceRuntimeManagementAuth, WorkspaceRuntimeManagementTarget } from "../management-auth"
import { WorkspaceRuntimeRoutes } from "./manifest"

const log = Log.create({ service: "config-route" })

export type RuntimeHarness = SessionHarness
export type RuntimeRunner = RuntimeHarness

export type RuntimeCommandItem = {
  name: string
  content: string
}

export type RuntimeSnapshotV1 = {
  version: 1
  mcp: Record<string, unknown>
  harness: RuntimeHarness
  model?: string
  auth: Record<string, string>
  agent_extensions?: {
    version: 1
    installs: Array<{
      desired: Record<string, unknown>
      lock?: Record<string, unknown>
      status?: string
      components?: Array<Record<string, unknown>>
    }>
  }
  workspaceHarnessEnabled?: boolean
  commands?: RuntimeCommandItem[]
}

export type RuntimeSnapshotV2 = Omit<RuntimeSnapshotV1, "version" | "harness"> & {
  version: 2
  harnesses: RuntimeHarness[]
}

export type LegacyRuntimeSnapshotV1 = Omit<RuntimeSnapshotV1, "harness"> & {
  runner: unknown
}

export type LegacyRuntimeSnapshotV2 = Omit<RuntimeSnapshotV2, "harnesses"> & {
  runners: unknown[]
}

export type RuntimeSnapshot = RuntimeSnapshotV1 | RuntimeSnapshotV2 | LegacyRuntimeSnapshotV1 | LegacyRuntimeSnapshotV2
export type AppliedRuntimeSnapshot = RuntimeSnapshotV1

export class RuntimeConfigApplyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 409 | 500 = 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "RuntimeConfigApplyError"
  }
}

export type ConfigRouteOptions = {
  managementAuth?: WorkspaceRuntimeManagementAuth
  managementTarget?: WorkspaceRuntimeManagementTarget
}

type AuthCtx = {
  req: {
    raw: Request
    path: string
    method: string
    header(name: string): string | undefined
  }
  get(name: "relayHostAuth"): RelayHostAuthContext["relayHostAuth"] | undefined
  get(name: "relayHostDirectAuth"): RelayHostAuthContext["relayHostDirectAuth"] | undefined
}

type AuthVerdict = { ok: true } | { ok: false; code: string; message: string; status: 401 | 403 }

function record(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function stringRecord(input: unknown): input is Record<string, string> {
  return record(input) && Object.values(input).every((item) => typeof item === "string")
}

function validTransport(input: unknown) {
  return input === undefined || normalizeAgentHarnessTransport(input) !== undefined
}

function processConnection(input: Record<string, unknown>): HarnessConnection | undefined {
  if (input.connection && record(input.connection)) {
    if (input.connection.kind === "process") {
      return {
        kind: "process",
        ...(typeof input.connection.binary === "string" ? { binary: input.connection.binary } : {}),
        ...(Array.isArray(input.connection.args) && input.connection.args.every((item) => typeof item === "string")
          ? { args: input.connection.args }
          : {}),
      }
    }
    if (input.connection.kind === "remote") {
      const transport = normalizeAgentHarnessTransport(input.connection.transport)
      return {
        kind: "remote",
        ...(transport ? { transport } : {}),
        ...(typeof input.connection.url === "string" ? { url: input.connection.url } : {}),
        ...(stringRecord(input.connection.headers) ? { headers: input.connection.headers } : {}),
      }
    }
  }
  if (typeof input.url === "string" || stringRecord(input.headers) || input.transport !== undefined) {
    const transport = normalizeAgentHarnessTransport(input.transport)
    return {
      kind: "remote",
      ...(transport ? { transport } : {}),
      ...(typeof input.url === "string" ? { url: input.url } : {}),
      ...(stringRecord(input.headers) ? { headers: input.headers } : {}),
    }
  }
  if (typeof input.binary === "string") return { kind: "process", binary: input.binary }
}

function normalizeHarness(input: unknown): RuntimeHarness | undefined {
  if (!record(input)) return
  const identity = normalizeHarnessIdentity(input)
  if (!identity) return
  if (!isAgentHarnessId(identity.id) || !isAgentHarnessAccess(identity.access)) return
  const connection = processConnection(input)
  return {
    id: identity.id,
    access: identity.access,
    ...(connection ? { connection } : {}),
  }
}

function validHarness(input: unknown): input is RuntimeHarness {
  return normalizeHarness(input) !== undefined
}

function agentExtensionsValidationProblem(input: unknown) {
  if (!record(input) || input.version !== 1 || !Array.isArray(input.installs)) {
    return {
      code: "runtime_config_agent_extensions_malformed",
      message: "Invalid runtime agent extension snapshot",
    }
  }
  for (const install of input.installs) {
    if (
      !record(install)
      || !record(install.desired)
      || (install.lock !== undefined && !record(install.lock))
      || (install.status !== undefined && typeof install.status !== "string")
      || (install.components !== undefined && (!Array.isArray(install.components) || !install.components.every(record)))
    ) {
      return {
        code: "runtime_config_agent_extensions_malformed",
        message: "Invalid runtime agent extension snapshot",
      }
    }
    const source = install.desired.source
    if (source === undefined && install.desired.enabled === false) continue
    if (!record(source) || typeof source.type !== "string") {
      return {
        code: "runtime_config_agent_extensions_malformed",
        message: "Invalid runtime agent extension snapshot",
      }
    }
    if (source.type !== "github" && source.type !== "project") {
      return {
        code: "runtime_config_agent_extensions_unsupported_source",
        message: "Unsupported runtime agent extension source",
      }
    }
    if (
      (source.type === "github" && (typeof source.owner !== "string" || typeof source.repo !== "string"))
      || (source.package_path !== undefined && typeof source.package_path !== "string")
      || (record(install.lock) && install.lock.resolved_sha !== undefined && typeof install.lock.resolved_sha !== "string")
      || (install.desired.targets !== undefined && (!Array.isArray(install.desired.targets) || !install.desired.targets.every((item) => typeof item === "string")))
    ) {
      return {
        code: "runtime_config_agent_extensions_malformed",
        message: "Invalid runtime agent extension snapshot",
      }
    }
  }
}

function normalizeAgentExtensions(input: unknown): RuntimeSnapshotV1["agent_extensions"] | undefined {
  if (input === undefined) return
  if (agentExtensionsValidationProblem(input)) return
  return input as RuntimeSnapshotV1["agent_extensions"]
}

export function normalizeRuntimeSnapshot(input: unknown): AppliedRuntimeSnapshot | undefined {
  if (
    !record(input)
    || !record(input.mcp)
    || !stringRecord(input.auth)
  ) return

  if (input.version === 1) {
    const harness = normalizeHarness((input as { harness?: unknown; runner?: unknown }).harness ?? (input as { runner?: unknown }).runner)
    if (!harness) return
    const agentExtensions = normalizeAgentExtensions(input.agent_extensions)
    if (input.agent_extensions !== undefined && !agentExtensions) return
    const snapshot = input as RuntimeSnapshotV1 | LegacyRuntimeSnapshotV1
    const legacyRunner = record((input as { runner?: unknown }).runner) ? (input as { runner: Record<string, unknown> }).runner : undefined
    return {
      version: 1,
      mcp: snapshot.mcp,
      harness,
      ...(typeof input.model === "string" ? { model: input.model } : typeof legacyRunner?.model === "string" ? { model: legacyRunner.model } : {}),
      auth: snapshot.auth,
      ...(agentExtensions ? { agent_extensions: agentExtensions } : {}),
      ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
      ...(snapshot.commands ? { commands: snapshot.commands } : {}),
    }
  }

  if (input.version === 2) {
    const list = Array.isArray((input as { harnesses?: unknown }).harnesses)
      ? (input as { harnesses: unknown[] }).harnesses
      : Array.isArray((input as { runners?: unknown }).runners)
        ? (input as { runners: unknown[] }).runners
        : undefined
    if (!list || !list.every(validHarness)) return
    const harness = normalizeHarness(list[0])
    if (!harness) return
    const agentExtensions = normalizeAgentExtensions(input.agent_extensions)
    if (input.agent_extensions !== undefined && !agentExtensions) return
    const snapshot = input as RuntimeSnapshotV2 | LegacyRuntimeSnapshotV2
    return {
      version: 1,
      mcp: snapshot.mcp,
      harness,
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      auth: snapshot.auth,
      ...(agentExtensions ? { agent_extensions: agentExtensions } : {}),
      ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
      ...(snapshot.commands ? { commands: snapshot.commands } : {}),
    }
  }
}

async function authorize(c: AuthCtx, options: ConfigRouteOptions): Promise<AuthVerdict> {
  if (!options.managementAuth || !options.managementTarget) {
    return {
      ok: false,
      code: "runtime_config_auth_required",
      message: "Runtime config management auth is required",
      status: 401,
    }
  }
  try {
    const result = await options.managementAuth.authorize({
      request: c.req.raw,
      action: "runtime.config.apply",
      target: options.managementTarget,
      path: c.req.path,
      method: c.req.method,
      relayAuth: c.get("relayHostAuth") ?? c.get("relayHostDirectAuth"),
    })
    if (
      result.ok === true
      && typeof result.subject === "string"
      && Array.isArray(result.scopes)
      && result.scopes.every((item) => typeof item === "string")
    ) return { ok: true }
    if (
      result.ok === false
      && (result.status === 401 || result.status === 403)
      && typeof result.code === "string"
      && typeof result.message === "string"
    ) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        status: result.status,
      }
    }
  } catch {}
  return {
    ok: false,
    code: "runtime_config_auth_failed",
    message: "Runtime config management auth failed",
    status: 401,
  }
}

export const ConfigRoutes = (apply: (snapshot: AppliedRuntimeSnapshot) => Promise<void>, options: ConfigRouteOptions = {}) =>
  new Hono<{ Variables: RelayHostAuthContext }>()
    .onError((err, c) => {
      if (isRequestBodyTooLarge(err)) return c.json(requestBodyTooLargeBody(), 413)
      throw err
    })
    .post(WorkspaceRuntimeRoutes.config, async (c) => {
      const verdict = await authorize(c, options)
      if (!verdict.ok) {
        return c.json({
          error: {
            code: verdict.code,
            message: verdict.message,
          },
        }, verdict.status)
      }
      const raw = await boundedJsonBody<RuntimeSnapshot | null>(c, null)
      const agentExtensionsProblem = record(raw) && raw.agent_extensions !== undefined
        ? agentExtensionsValidationProblem(raw.agent_extensions)
        : undefined
      if (agentExtensionsProblem) {
        return c.json(errorBody(agentExtensionsProblem.code, agentExtensionsProblem.message), 400)
      }
      const body = normalizeRuntimeSnapshot(raw)
      if (!body) {
        return c.json(errorBody("invalid_runtime_snapshot", "Invalid runtime snapshot"), 400)
      }
      try {
        await apply(body)
        log.info("Applied runtime snapshot", {
          harness: body.harness.id,
          access: body.harness.access,
        })
        return c.json({ ok: true })
      } catch (err) {
        log.error("Failed to apply runtime snapshot", {
          error: err instanceof Error ? err.message : String(err),
        })
        if (err instanceof RuntimeConfigApplyError) {
          return c.json(errorBody(err.code, err.message, err.details), err.status)
        }
        return c.json(errorBody("runtime_snapshot_apply_failed", "Runtime config apply failed"), 500)
      }
    })
