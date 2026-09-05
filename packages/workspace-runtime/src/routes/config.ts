import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "../log"
import { isAgentHarnessId, type HarnessConnectionDescriptor, type SessionHarness } from "@claxedo/agent-sdk-runtime"
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
  /**
   * Opaque per-harness launch options a containing product projects (Claxedo's
   * Agent Plugins module contributes plugin roots this way). Keyed by agent
   * harness id; the kit validates the shape and hands the row to the adapter's
   * `applyConfig` untouched.
   */
  harnessLaunch?: Record<string, Record<string, unknown>>
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
  "connections",
  "defaultHarness",
  "auth",
  "harnessLaunch",
  "workspaceHarnessEnabled",
  "commands",
])

export function normalizeRuntimeSnapshot(input: unknown): AppliedRuntimeSnapshot | undefined {
  if (
    !record(input)
    || input.version !== 3
    || !record(input.mcp)
    || !Array.isArray(input.connections)
    || !stringRecord(input.auth)
  ) return
  // Unknown fields are rejected rather than silently dropped: a producer that
  // sends a field this runtime does not model would otherwise believe it took.
  if (Object.keys(input).some((key) => !RUNTIME_SNAPSHOT_KEYS.has(key))) return
  const connections = input.connections.map(normalizeDescriptor)
  if (connections.some((row) => !row)) return
  const ids = connections.map((row) => row!.connectionId)
  if (new Set(ids).size !== ids.length) return
  const defaultHarness = input.defaultHarness === undefined ? undefined : normalizeSelection(input.defaultHarness)
  if (input.defaultHarness !== undefined && !defaultHarness) return
  if (defaultHarness?.kind === "connection" && !connections.some((row) => row!.connectionId === defaultHarness.connectionId)) return
  const harnessLaunch = normalizeHarnessLaunch(input.harnessLaunch)
  if (!harnessLaunch) return
  if (input.workspaceHarnessEnabled !== undefined && typeof input.workspaceHarnessEnabled !== "boolean") return
  if (input.commands !== undefined && (!Array.isArray(input.commands) || !input.commands.every((row) => record(row) && typeof row.name === "string" && typeof row.content === "string"))) return
  return {
    version: 3,
    mcp: input.mcp,
    connections: connections as RuntimeConnectionDescriptor[],
    ...(defaultHarness ? { defaultHarness } : {}),
    auth: input.auth,
    ...(Object.keys(harnessLaunch).length ? { harnessLaunch } : {}),
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
