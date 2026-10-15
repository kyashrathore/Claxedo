import { ServerError } from "../errors"
import type { WorkspaceBootMode, WorkspaceStartStep } from "../cloud-types"
import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"

export type RelayConnection = {
  readonly sessionId?: string
  readonly workspaceId: string
  readonly relayUrl: string
  readonly runtimeAccessToken: string
  readonly tokenExpiresAt: number
}

export type StartElapsed = { readonly done: readonly WorkspaceStartStep[]; readonly sinceStartMs: number; readonly sinceStepMs: number }

export type ConnectionAnswer =
  | { readonly kind: "ready"; readonly link: RelayConnection; readonly sessionHostRoot?: string }
  | { readonly kind: "provisioning"; readonly retryAfterMs?: number; readonly bootMode?: WorkspaceBootMode; readonly failure?: string; readonly progress?: StartElapsed }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly reason: string }

export type WorkspaceConnections = {
  readonly read: (workspaceId: string, sessionId?: string) => Promise<ConnectionAnswer>
  readonly start: (workspaceId: string) => Promise<ConnectionAnswer>
  readonly mintSession: (workspaceId: string, sessionId: string) => Promise<ConnectionAnswer>
}

export const WORKSPACE_STOPPED = "workspace_stopped"
export const CLOUD_RUNTIME_UNAVAILABLE = "cloud_runtime_unavailable"
export const CLOUD_RUNTIME_BOOT_FAILED = "cloud_runtime_boot_failed"
const WORKSPACE_HOST_OFFLINE = "workspace_host_offline"
const WORKSPACE_CHECKPOINT_FROZEN = "workspace_checkpoint_frozen"

export function workspaceStopped(workspaceId: string): ServerError {
  return new ServerError({ class: "conflict", code: WORKSPACE_STOPPED, message: `The cloud workspace ${workspaceId} is not running` })
}

const CLOUD_RUNTIME_IMAGE_OUTDATED = "cloud_runtime_image_outdated"

export function isImageOutdated(error: unknown): boolean {
  return error instanceof ServerError && error.code === CLOUD_RUNTIME_IMAGE_OUTDATED
}

export function isCheckpointFrozen(error: unknown): boolean {
  return error instanceof ServerError && error.code === WORKSPACE_CHECKPOINT_FROZEN
}

export function isRuntimeUnavailable(error: unknown): boolean {
  return error instanceof ServerError && (error.code === WORKSPACE_STOPPED || error.code === WORKSPACE_HOST_OFFLINE)
}

function bootModeOf(value: unknown): WorkspaceBootMode | undefined {
  return value === "restore" || value === "resume" || value === "cold-start" ? value : undefined
}

function durationOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

const START_STEPS: readonly WorkspaceStartStep[] = ["machine", "image", "runtime"]

const STEPS_DONE_BY_PHASE: Readonly<Record<string, readonly WorkspaceStartStep[]>> = {
  machine_ready: ["machine"],
  image_ready: ["machine", "image"],
  runtime_ready: ["machine", "image", "runtime"],
}

function startElapsedOf(value: unknown): StartElapsed | undefined {
  if (!isRecord(value) || !Array.isArray(value.phases)) return undefined
  const sinceStartMs = durationOf(value.sinceStartMs)
  const sinceStepMs = durationOf(value.sinceStepMs)
  if (sinceStartMs === undefined || sinceStepMs === undefined) return undefined
  const reached = new Set(value.phases.flatMap((phase) => (typeof phase === "string" ? (STEPS_DONE_BY_PHASE[phase] ?? []) : [])))
  return { done: START_STEPS.filter((step) => reached.has(step)), sinceStartMs, sinceStepMs }
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
  if (row.status === "failed") return { kind: "failed", reason: typeof row.error === "string" && row.error ? row.error : "The cloud workspace could not start" }
  if (row.status === "provisioning") {
    const retryAfterMs = durationOf(row.retryAfterMs)
    const bootMode = bootModeOf(row.bootMode)
    const failure = nonEmptyString(row.failure)
    const progress = startElapsedOf(row.progress)
    return { kind: "provisioning", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(bootMode ? { bootMode } : {}), ...(failure ? { failure } : {}), ...(progress ? { progress } : {}) }
  }
  if (sessionId && row.sessionId !== sessionId) throw new ServerError({ class: "internal", message: "Session connection scope does not match the requested session" })
  const link = { ...linkOf(row, workspaceId), ...(sessionId ? { sessionId } : {}) }
  return { kind: "ready", link, ...(row.backing === "durable-object" && sessionId ? { sessionHostRoot: sessionId } : {}) }
}

export function unavailableRetry(body: unknown): Extract<ConnectionAnswer, { kind: "provisioning" }> | undefined {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
  const retryAfterMs = durationOf(error?.retryAfterMs)
  if (retryAfterMs === undefined) return undefined
  const failure = nonEmptyString(error?.failure)
  return { kind: "provisioning", retryAfterMs, ...(failure ? { failure } : {}) }
}
