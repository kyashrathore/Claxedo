import { sleep } from "@claxedo/helpers"
import type { WorkspaceStartProgress } from "./cloud-types"
import { ServerError } from "./errors"
import { CLOUD_RUNTIME_BOOT_FAILED, type ConnectionAnswer, type RelayConnection } from "./wire/connection"

export type StartOptions = {
  readonly onProgress?: (progress: WorkspaceStartProgress) => void
  readonly wait?: (ms: number) => Promise<void>
}

const DEFAULT_RETRY_MS = 2_000
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 30_000

const retryDelay = (retryAfterMs: number | undefined) => Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, retryAfterMs ?? DEFAULT_RETRY_MS))

type Connect = (workspaceId: string) => Promise<ConnectionAnswer>

async function settledAnswer(connect: Connect, workspaceId: string, options: StartOptions): Promise<Exclude<ConnectionAnswer, { kind: "provisioning" }>> {
  const wait = options.wait ?? sleep
  for (;;) {
    const answer = await connect(workspaceId)
    if (answer.kind !== "provisioning") return answer
    options.onProgress?.({ kind: "provisioning", ...(answer.bootMode ? { bootMode: answer.bootMode } : {}) })
    await wait(retryDelay(answer.retryAfterMs))
  }
}

export async function startWorkspace(connect: Connect, workspaceId: string, options: StartOptions = {}): Promise<RelayConnection> {
  const answer = await settledAnswer(connect, workspaceId, options)
  if (answer.kind === "ready") return answer.link
  if (answer.kind === "stopped") throw new ServerError({ class: "internal", message: `The start of ${workspaceId} answered that it is stopped` })
  throw new ServerError({ class: "conflict", code: CLOUD_RUNTIME_BOOT_FAILED, message: answer.reason })
}

export async function followWorkspaceStart(read: Connect, workspaceId: string, options: StartOptions = {}): Promise<RelayConnection | undefined> {
  const answer = await settledAnswer(read, workspaceId, options)
  return answer.kind === "ready" ? answer.link : undefined
}
