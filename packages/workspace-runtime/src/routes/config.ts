import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { Log } from "../log"
import {
  isAgentHarnessId,
  providerProjectionRecord,
  type HarnessConnectionDescriptor,
  type ProviderProjection,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import { isRecord } from "@claxedo/helpers/guards"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { boundedJsonBody, errorBody, isRequestBodyTooLarge, requestBodyTooLargeBody } from "./http"
import type { WorkspaceRuntimeManagementAuth, WorkspaceRuntimeManagementTarget } from "../management-auth"
import { WorkspaceRuntimeRoutes } from "./manifest"
import { isRecord as record, str } from "../json-value"

const log = Log.create({ service: "config-route" })

export const RUNTIME_NATIVE_HARNESS_IDS = ["claude", "codex", "cursor", "pi", "opencode"] as const
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
  return undefined
}

export type RuntimeCommandItem = {
  name: string
  content: string
}

export type { ProviderProjection }

export type RuntimeSnapshot = {
  version: 4
  mcp: Record<string, unknown>
  connections: RuntimeConnectionDescriptor[]
  defaultHarness?: RuntimeHarnessSelection
  /**
   * What each provider's harness gets in place of a credential. The value stays
   * with the authority that minted the binding; this carries only the broker
   * endpoint and a placeholder scoped to it.
   */
  auth: Record<string, ProviderProjection>
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

function stringRecord(input: unknown): input is Record<string, string> {
  return isRecord(input) && Object.values(input).every((item) => typeof item === "string")
}

function normalizeSelection(input: unknown): RuntimeHarnessSelection | undefined {
  if (!record(input)) return undefined
  if (input.kind === "native" && Object.keys(input).every((key) => key === "kind" || key === "harnessId")) {
    // `find` over the canonical list yields the literal type; a membership test
    // would leave a bare `string` and force an assertion.
    const harnessId = RUNTIME_NATIVE_HARNESS_IDS.find((id) => id === input.harnessId)
    if (harnessId) return { kind: "native", harnessId }
  }
  if (
    input.kind === "connection"
    && typeof input.connectionId === "string"
    && input.connectionId.trim().length > 0
    && Object.keys(input).every((key) => key === "kind" || key === "connectionId")
  ) return { kind: "connection", connectionId: input.connectionId }
  return undefined
}

function normalizeDescriptor(input: unknown): RuntimeConnectionDescriptor | undefined {
  if (!record(input)) return undefined
  if (typeof input.connectionId !== "string" || !input.connectionId.trim()) return undefined
  if (typeof input.providerKey !== "string" || !input.providerKey.trim()) return undefined
  if (typeof input.configRevision !== "number" || !Number.isSafeInteger(input.configRevision) || input.configRevision < 1) return undefined
  if (typeof input.enabled !== "boolean" || !record(input.config)) return undefined
  if (input.secretRefs !== undefined && !stringRecord(input.secretRefs)) return undefined
  const allowed = new Set(["connectionId", "providerKey", "configRevision", "enabled", "config", "secretRefs"])
  if (Object.keys(input).some((key) => !allowed.has(key))) return undefined
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
  if (!record(input)) return undefined
  const rows: Record<string, Record<string, unknown>> = {}
  for (const [harnessId, value] of Object.entries(input)) {
    if (!isAgentHarnessId(harnessId) || !record(value)) return undefined
    rows[harnessId] = value
  }
  return rows
}

/** One command entry as the wire may carry it, or `undefined` when malformed. */
function normalizeCommand(input: unknown): RuntimeCommandItem | undefined {
  if (!record(input)) return undefined
  const name = str(input.name)
  const content = str(input.content)
  return name !== undefined && content !== undefined ? { name, content } : undefined
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
    !isRecord(input)
    || input.version !== 4
    || !isRecord(input.mcp)
    || !Array.isArray(input.connections)
  ) return undefined
  const auth = providerProjectionRecord(input.auth)
  if (!auth) return undefined
  // Unknown fields are rejected rather than silently dropped: a producer that
  // sends a field this runtime does not model would otherwise believe it took.
  if (Object.keys(input).some((key) => !RUNTIME_SNAPSHOT_KEYS.has(key))) return undefined
  // Collected instead of mapped-then-asserted, so the array's element type comes
  // from the validator rather than from a claim about it.
  const connections: RuntimeConnectionDescriptor[] = []
  for (const row of input.connections) {
    const descriptor = normalizeDescriptor(row)
    if (!descriptor) return undefined
    connections.push(descriptor)
  }
  const ids = connections.map((row) => row.connectionId)
  if (new Set(ids).size !== ids.length) return undefined
  const defaultHarness = input.defaultHarness === undefined ? undefined : normalizeSelection(input.defaultHarness)
  if (input.defaultHarness !== undefined && !defaultHarness) return undefined
  if (defaultHarness?.kind === "connection" && !connections.some((row) => row.connectionId === defaultHarness.connectionId)) return undefined
  const harnessLaunch = normalizeHarnessLaunch(input.harnessLaunch)
  if (!harnessLaunch) return undefined
  if (input.workspaceHarnessEnabled !== undefined && typeof input.workspaceHarnessEnabled !== "boolean") return undefined
  let commands: RuntimeCommandItem[] | undefined
  if (input.commands !== undefined) {
    if (!Array.isArray(input.commands)) return undefined
    commands = []
    for (const row of input.commands) {
      const command = normalizeCommand(row)
      if (!command) return undefined
      commands.push(command)
    }
  }
  return {
    version: 4,
    mcp: input.mcp,
    connections,
    ...(defaultHarness ? { defaultHarness } : {}),
    auth,
    ...(Object.keys(harnessLaunch).length ? { harnessLaunch } : {}),
    ...(typeof input.workspaceHarnessEnabled === "boolean" ? { workspaceHarnessEnabled: input.workspaceHarnessEnabled } : {}),
    ...(commands ? { commands } : {}),
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
      
      result.ok
      && typeof result.subject === "string"
      && Array.isArray(result.scopes)
      && result.scopes.every((item) => typeof item === "string")
    ) return { ok: true }
    if (
      !
      result.ok
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
      const raw = await boundedJsonBody(c)
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
