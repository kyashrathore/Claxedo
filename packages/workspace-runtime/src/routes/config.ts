import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "../log"
import type { HarnessConnectionDescriptor, SessionHarness } from "@claxedo/agent-sdk-runtime"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import type { WorkspaceRuntimeManagementAuth, WorkspaceRuntimeManagementTarget } from "../management-auth"
import { WorkspaceRuntimeRoutes } from "./manifest"

const log = Log.create({ service: "config-route" })

export const RUNTIME_NATIVE_HARNESS_IDS = ["claude", "codex", "cursor", "pi"] as const
export type RuntimeNativeHarnessId = (typeof RUNTIME_NATIVE_HARNESS_IDS)[number]
export type RuntimeHarnessSelection =
  | { kind: "native"; harnessId: RuntimeNativeHarnessId }
  | { kind: "connection"; connectionId: string }

export type RuntimeConnectionDescriptor = HarnessConnectionDescriptor

export function requestedSessionHarness(req: { query(name: string): string | undefined }): SessionHarness | undefined {
  const nativeHarness = req.query("nativeHarness")
  const connectionId = req.query("connectionId")
  if (req.query("harness") !== undefined || req.query("runner") !== undefined) {
    throw new HTTPException(400, { message: "Use nativeHarness or connectionId to select a harness" })
  }
  if (nativeHarness !== undefined && connectionId !== undefined) {
    throw new HTTPException(400, { message: "Select either nativeHarness or connectionId" })
  }
  if (nativeHarness !== undefined) {
    if (!RUNTIME_NATIVE_HARNESS_IDS.some((id) => id === nativeHarness)) {
      throw new HTTPException(400, { message: "Unknown native harness" })
    }
    return { id: nativeHarness, access: "native" }
  }
  if (connectionId !== undefined) {
    if (!connectionId.trim()) throw new HTTPException(400, { message: "connectionId must not be empty" })
    return { id: connectionId, access: "connection" }
  }
}

export type RuntimeCommandItem = {
  name: string
  content: string
}

export type RuntimeSnapshot = {
  version: 3
  mcp: Record<string, unknown>
  connections: RuntimeConnectionDescriptor[]
  defaultHarness?: RuntimeHarnessSelection
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
export type AppliedRuntimeSnapshot = RuntimeSnapshot

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

function normalizeSelection(input: unknown): RuntimeHarnessSelection | undefined {
  if (!record(input)) return
  if (
    input.kind === "native"
    && typeof input.harnessId === "string"
    && RUNTIME_NATIVE_HARNESS_IDS.some((id) => id === input.harnessId)
    && Object.keys(input).every((key) => key === "kind" || key === "harnessId")
  ) return { kind: "native", harnessId: input.harnessId as RuntimeNativeHarnessId }
  if (
    input.kind === "connection"
    && typeof input.connectionId === "string"
    && input.connectionId.trim().length > 0
    && Object.keys(input).every((key) => key === "kind" || key === "connectionId")
  ) return { kind: "connection", connectionId: input.connectionId }
}

function normalizeDescriptor(input: unknown): RuntimeConnectionDescriptor | undefined {
  if (!record(input)) return
  if (typeof input.connectionId !== "string" || !input.connectionId.trim()) return
  if (typeof input.providerKey !== "string" || !input.providerKey.trim()) return
  if (typeof input.configRevision !== "number" || !Number.isSafeInteger(input.configRevision) || input.configRevision < 1) return
  if (typeof input.enabled !== "boolean" || !record(input.config)) return
  if (input.secretRefs !== undefined && !stringRecord(input.secretRefs)) return
  const allowed = new Set(["connectionId", "providerKey", "configRevision", "enabled", "config", "secretRefs"])
  if (Object.keys(input).some((key) => !allowed.has(key))) return
  return {
    connectionId: input.connectionId,
    providerKey: input.providerKey,
    configRevision: input.configRevision,
    enabled: input.enabled,
    config: input.config,
    ...(stringRecord(input.secretRefs) ? { secretRefs: input.secretRefs } : {}),
  }
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

function normalizeAgentExtensions(input: unknown): RuntimeSnapshot["agent_extensions"] | undefined {
  if (input === undefined) return
  if (agentExtensionsValidationProblem(input)) return
  return input as RuntimeSnapshot["agent_extensions"]
}

export function normalizeRuntimeSnapshot(input: unknown): AppliedRuntimeSnapshot | undefined {
  if (
    !record(input)
    || input.version !== 3
    || !record(input.mcp)
    || !Array.isArray(input.connections)
    || !stringRecord(input.auth)
  ) return
  const connections = input.connections.map(normalizeDescriptor)
  if (connections.some((row) => !row)) return
  const ids = connections.map((row) => row!.connectionId)
  if (new Set(ids).size !== ids.length) return
  const defaultHarness = input.defaultHarness === undefined ? undefined : normalizeSelection(input.defaultHarness)
  if (input.defaultHarness !== undefined && !defaultHarness) return
  if (defaultHarness?.kind === "connection" && !connections.some((row) => row!.connectionId === defaultHarness.connectionId)) return
  const agentExtensions = normalizeAgentExtensions(input.agent_extensions)
  if (input.agent_extensions !== undefined && !agentExtensions) return
  if (input.workspaceHarnessEnabled !== undefined && typeof input.workspaceHarnessEnabled !== "boolean") return
  if (input.commands !== undefined && (!Array.isArray(input.commands) || !input.commands.every((row) => record(row) && typeof row.name === "string" && typeof row.content === "string"))) return
  return {
    version: 3,
    mcp: input.mcp,
    connections: connections as RuntimeConnectionDescriptor[],
    ...(defaultHarness ? { defaultHarness } : {}),
    auth: input.auth,
    ...(agentExtensions ? { agent_extensions: agentExtensions } : {}),
    ...(typeof input.workspaceHarnessEnabled === "boolean" ? { workspaceHarnessEnabled: input.workspaceHarnessEnabled } : {}),
    ...(Array.isArray(input.commands) ? { commands: input.commands as RuntimeCommandItem[] } : {}),
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
          connectionCount: body.connections.length,
          selection: body.defaultHarness,
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
