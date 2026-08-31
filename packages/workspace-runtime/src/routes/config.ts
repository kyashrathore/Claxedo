import { Hono } from "hono"
import { Log } from "../log"
import {
  isAcpConnectionId,
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
  workspaceHarnessEnabled?: boolean
  commands?: RuntimeCommandItem[]
  /** Opaque per-harness launch options; interpreted only by that harness. */
  harnessLaunch?: Record<string, Record<string, unknown>>
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
/**
 * The normalized form the engine applies. `harness` is the ACTIVE runner (v2's
 * first row); `harnesses` retains EVERY validated row so the runtime holds the
 * full accepted registry — in particular operator-configured ACP connections a
 * session may select later.
 */
export type AppliedRuntimeSnapshot = RuntimeSnapshotV1 & { harnesses?: RuntimeHarness[] }

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
        ...(stringRecord(input.connection.env) ? { env: input.connection.env as Record<string, string> } : {}),
        ...(typeof input.connection.supportsMcpServers === "boolean"
          ? { supportsMcpServers: input.connection.supportsMcpServers }
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
  if (!isAgentHarnessAccess(identity.access)) return
  // Built-in ids are accepted for either access; an open validated ACP
  // connection slug is accepted ONLY as `access: "acp"` — native dispatch
  // stays closed to the finite id set.
  if (!isAgentHarnessId(identity.id) && !(identity.access === "acp" && isAcpConnectionId(identity.id))) return
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

function normalizeHarnessLaunch(input: unknown): Record<string, Record<string, unknown>> | undefined {
  if (input === undefined) return {}
  if (!record(input)) return
  const rows: Record<string, Record<string, unknown>> = {}
  for (const [harnessId, value] of Object.entries(input)) {
    if (!isAgentHarnessId(harnessId) || !record(value)) return
    rows[harnessId] = value
  }
  return rows
}

const RUNTIME_SNAPSHOT_KEYS = new Set([
  "version",
  "mcp",
  "harness",
  "harnesses",
  "runner",
  "runners",
  "model",
  "auth",
  "workspaceHarnessEnabled",
  "commands",
  "harnessLaunch",
])

export function normalizeRuntimeSnapshot(input: unknown): AppliedRuntimeSnapshot | undefined {
  if (
    !record(input)
    || !record(input.mcp)
    || !stringRecord(input.auth)
    || Object.keys(input).some((key) => !RUNTIME_SNAPSHOT_KEYS.has(key))
  ) return
  const harnessLaunch = normalizeHarnessLaunch(input.harnessLaunch)
  if (!harnessLaunch) return

  if (input.version === 1) {
    const harness = normalizeHarness((input as { harness?: unknown; runner?: unknown }).harness ?? (input as { runner?: unknown }).runner)
    if (!harness) return
    const snapshot = input as RuntimeSnapshotV1 | LegacyRuntimeSnapshotV1
    const legacyRunner = record((input as { runner?: unknown }).runner) ? (input as { runner: Record<string, unknown> }).runner : undefined
    // An already-normalized applied snapshot re-enters here (routes normalize,
    // then host.apply normalizes again) — a valid retained registry must
    // survive the round trip.
    const retained = Array.isArray((input as { harnesses?: unknown }).harnesses)
      && (input as { harnesses: unknown[] }).harnesses.every(validHarness)
      ? (input as { harnesses: unknown[] }).harnesses.map((row) => normalizeHarness(row)!)
      : undefined
    return {
      version: 1,
      mcp: snapshot.mcp,
      harness,
      ...(retained ? { harnesses: retained } : {}),
      ...(typeof input.model === "string" ? { model: input.model } : typeof legacyRunner?.model === "string" ? { model: legacyRunner.model } : {}),
      auth: snapshot.auth,
      ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
      ...(snapshot.commands ? { commands: snapshot.commands } : {}),
      ...(Object.keys(harnessLaunch).length ? { harnessLaunch } : {}),
    }
  }

  if (input.version === 2) {
    const list = Array.isArray((input as { harnesses?: unknown }).harnesses)
      ? (input as { harnesses: unknown[] }).harnesses
      : Array.isArray((input as { runners?: unknown }).runners)
        ? (input as { runners: unknown[] }).runners
        : undefined
    if (!list || !list.every(validHarness)) return
    const harnesses = list.map((row) => normalizeHarness(row)!)
    const harness = harnesses[0]
    if (!harness) return
    const snapshot = input as RuntimeSnapshotV2 | LegacyRuntimeSnapshotV2
    return {
      version: 1,
      mcp: snapshot.mcp,
      harness,
      harnesses,
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      auth: snapshot.auth,
      ...(snapshot.workspaceHarnessEnabled !== undefined ? { workspaceHarnessEnabled: snapshot.workspaceHarnessEnabled } : {}),
      ...(snapshot.commands ? { commands: snapshot.commands } : {}),
      ...(Object.keys(harnessLaunch).length ? { harnessLaunch } : {}),
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
