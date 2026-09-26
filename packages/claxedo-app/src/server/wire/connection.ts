import { ServerError } from "../errors"
import type { WorkspaceBootMode } from "../cloud-types"
import { isRecord } from "../../lib/record"

export type RelayConnection = {
  readonly workspaceId: string
  readonly relayUrl: string
  readonly runtimeAccessToken: string
  readonly tokenExpiresAt: number
}

export type ConnectionAnswer =
  | { readonly kind: "ready"; readonly link: RelayConnection }
  | { readonly kind: "provisioning"; readonly retryAfterMs?: number; readonly bootMode?: WorkspaceBootMode }
  | { readonly kind: "stopped" }

export const WORKSPACE_STOPPED = "workspace_stopped"
export const CLOUD_RUNTIME_UNAVAILABLE = "cloud_runtime_unavailable"

export function workspaceStopped(workspaceId: string): ServerError {
  return new ServerError({ class: "conflict", code: WORKSPACE_STOPPED, message: `The cloud workspace ${workspaceId} is not running` })
}

export function isWorkspaceStopped(error: unknown): boolean {
  return error instanceof ServerError && error.code === WORKSPACE_STOPPED
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

export function connectionAnswerFromWire(body: unknown, workspaceId: string): ConnectionAnswer {
  const row = isRecord(body) ? body : {}
  if (row.status === "stopped") return { kind: "stopped" }
  if (row.status === "provisioning") {
    const retryAfterMs = retryAfterOf(row.retryAfterMs)
    const bootMode = bootModeOf(row.bootMode)
    return { kind: "provisioning", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(bootMode ? { bootMode } : {}) }
  }
  return { kind: "ready", link: linkOf(row, workspaceId) }
}

export function unavailableRetryAfter(body: unknown): number | undefined {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
  return retryAfterOf(error?.retryAfterMs)
}
