import { sleep } from "@claxedo/helpers"
import type { WorkspaceStartProgress } from "./cloud-types"
import { responseError, ServerError } from "./errors"
import { CLOUD_RUNTIME_UNAVAILABLE, connectionAnswerFromWire, unavailableRetryAfter, type ConnectionAnswer, type RelayConnection } from "./wire/connection"

type Request = (path: string, init?: RequestInit) => Promise<Response>

export type StartOptions = {
  readonly onProgress?: (progress: WorkspaceStartProgress) => void
  readonly wait?: (ms: number) => Promise<void>
}

const START_ATTEMPTS = 30
const DEFAULT_RETRY_MS = 2_000
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 30_000

const retryDelay = (retryAfterMs: number | undefined) => Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, retryAfterMs ?? DEFAULT_RETRY_MS))

async function requestConnection(request: Request, workspaceId: string): Promise<ConnectionAnswer> {
  const response = await request(`/api/workspace/${encodeURIComponent(workspaceId)}/connection`, { method: "POST", body: "{}" })
  if (response.ok) return connectionAnswerFromWire(await response.json(), workspaceId)
  const body = response.clone()
  const error = await responseError(response, "Workspace start")
  const retryAfterMs = error.code === CLOUD_RUNTIME_UNAVAILABLE ? unavailableRetryAfter(JSON.parse(await body.text())) : undefined
  if (retryAfterMs === undefined) throw error
  return { kind: "provisioning", retryAfterMs }
}

export async function startWorkspace(request: Request, workspaceId: string, options: StartOptions = {}): Promise<RelayConnection> {
  const wait = options.wait ?? sleep
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const answer = await requestConnection(request, workspaceId)
    if (answer.kind === "ready") return answer.link
    if (answer.kind === "stopped") throw new ServerError({ class: "internal", message: `The start of ${workspaceId} answered that it is stopped` })
    options.onProgress?.({ kind: "provisioning", ...(answer.bootMode ? { bootMode: answer.bootMode } : {}) })
    await wait(retryDelay(answer.retryAfterMs))
  }
  throw new ServerError({ class: "network", code: "workspace_still_starting", message: `The cloud workspace ${workspaceId} is still starting` })
}
