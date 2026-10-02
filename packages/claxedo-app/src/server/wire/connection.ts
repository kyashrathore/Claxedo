import { ServerError } from "../errors"
import type { WorkspaceBootMode } from "../cloud-types"
import { isRecord } from "@claxedo/helpers/guards"

export type RelayConnection = {
  readonly sessionId?: string
  readonly workspaceId: string
  readonly relayUrl: string
  readonly runtimeAccessToken: string
  readonly tokenExpiresAt: number
}

export type ConnectionAnswer =
  | { readonly kind: "ready"; readonly link: RelayConnection }
  | { readonly kind: "provisioning"; readonly retryAfterMs?: number; readonly bootMode?: WorkspaceBootMode }
  | { readonly kind: "stopped" }

export type WorkspaceConnections = {
  readonly read: (workspaceId: string, sessionId?: string) => Promise<ConnectionAnswer>
  readonly start: (workspaceId: string) => Promise<ConnectionAnswer>
}

export const WORKSPACE_STOPPED = "workspace_stopped"
export const CLOUD_RUNTIME_UNAVAILABLE = "cloud_runtime_unavailable"
const WORKSPACE_HOST_OFFLINE = "workspace_host_offline"

export function workspaceStopped(workspaceId: string): ServerError {
  return new ServerError({ class: "conflict", code: WORKSPACE_STOPPED, message: `The cloud workspace ${workspaceId} is not running` })
}

export function isRuntimeUnavailable(error: unknown): boolean {
  return error instanceof ServerError && (error.code === WORKSPACE_STOPPED || error.code === WORKSPACE_HOST_OFFLINE)
}

function bootModeOf(value: unknown): WorkspaceBootMode | undefined {
  return value === "restore" || value === "resume" || value === "cold-start" ? value : undefined
}

function retryAfterOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function linkOf(row: Record<string, unknown>, workspaceId: string): RelayConnection {
  const { relayUrl, runtimeAccessToken, tokenExpiresAt } = row
  if (typeof relayUrl !== "string" || typeof runtimeAccessToken !== "string" || typeof tokenExpiresAt !== "number") {
    throw new ServerError({ class: "internal", message: `The workspace connection for ${workspaceId} is malformed` })
  }
  return { workspaceId, relayUrl: relayUrl.replace(/\/+$/, ""), runtimeAccessToken, tokenExpiresAt }
}

export function connectionAnswerFromWire(body: unknown, workspaceId: string, sessionId?: string): ConnectionAnswer {
  const row = isRecord(body) ? body : {}
  if (row.status === "stopped") return { kind: "stopped" }
  if (row.status === "provisioning") {
    const retryAfterMs = retryAfterOf(row.retryAfterMs)
    const bootMode = bootModeOf(row.bootMode)
    return { kind: "provisioning", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(bootMode ? { bootMode } : {}) }
  }
  if (sessionId && row.sessionId !== sessionId) throw new ServerError({ class: "internal", message: "Session connection scope does not match the requested session" })
  return { kind: "ready", link: { ...linkOf(row, workspaceId), ...(sessionId ? { sessionId } : {}) } }
}

export function unavailableRetryAfter(body: unknown): number | undefined {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
  return retryAfterOf(error?.retryAfterMs)
}
