import { sleep } from "@claxedo/helpers"
import type { WorkspaceStartProgress } from "./cloud-types"
import { ServerError } from "./errors"
import type { ConnectionAnswer, RelayConnection } from "./wire/connection"

export type StartOptions = {
  readonly onProgress?: (progress: WorkspaceStartProgress) => void
  readonly wait?: (ms: number) => Promise<void>
}

const START_ATTEMPTS = 30
const DEFAULT_RETRY_MS = 2_000
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 30_000

const retryDelay = (retryAfterMs: number | undefined) => Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, retryAfterMs ?? DEFAULT_RETRY_MS))

export async function startWorkspace(connect: (workspaceId: string) => Promise<ConnectionAnswer>, workspaceId: string, options: StartOptions = {}): Promise<RelayConnection> {
  const wait = options.wait ?? sleep
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const answer = await connect(workspaceId)
    if (answer.kind === "ready") return answer.link
    if (answer.kind === "stopped") throw new ServerError({ class: "internal", message: `The start of ${workspaceId} answered that it is stopped` })
    options.onProgress?.({ kind: "provisioning", ...(answer.bootMode ? { bootMode: answer.bootMode } : {}) })
    await wait(retryDelay(answer.retryAfterMs))
  }
  throw new ServerError({ class: "network", code: "workspace_still_starting", message: `The cloud workspace ${workspaceId} is still starting` })
}
