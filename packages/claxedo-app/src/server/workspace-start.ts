import { sleep } from "@claxedo/helpers"
import type { WorkspaceStartProgress } from "./cloud-types"
import { ServerError } from "./errors"
import { CLOUD_RUNTIME_BOOT_FAILED, type ConnectionAnswer, type RelayConnection } from "./wire/connection"

export type StartOptions = {
  readonly onProgress?: (progress: WorkspaceStartProgress) => void
  readonly wait?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly settled?: (listener: () => void) => () => void
  readonly pollDeadlineMs?: number
}

const DEFAULT_RETRY_MS = 2_000
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 30_000
const POLL_DEADLINE_MS = 30_000

const retryDelay = (retryAfterMs: number | undefined) => Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, retryAfterMs ?? DEFAULT_RETRY_MS))

type Connect = (workspaceId: string) => Promise<ConnectionAnswer>

type Provisioning = Extract<ConnectionAnswer, { kind: "provisioning" }>

function startProgressOf(answer: Provisioning, receivedAt: number): WorkspaceStartProgress {
  const elapsed = answer.progress
  return {
    kind: "provisioning",
    ...(answer.bootMode ? { bootMode: answer.bootMode } : {}),
    ...(answer.failure ? { failure: answer.failure } : {}),
    ...(elapsed ? { steps: { done: elapsed.done, startedAt: receivedAt - elapsed.sinceStartMs, stepStartedAt: receivedAt - elapsed.sinceStepMs } } : {}),
  }
}

function unlessCutShort<T>(work: Promise<T>, settled: StartOptions["settled"], deadlineMs?: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopListening: (() => void) | undefined
    const finish = (settle: () => void) => {
      clearTimeout(timer)
      stopListening?.()
      settle()
    }
    const cut = () => finish(() => resolve(undefined))
    stopListening = settled?.(cut)
    if (deadlineMs !== undefined) timer = setTimeout(cut, deadlineMs)
    work.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)))
  })
}

async function settledAnswer(connect: Connect, workspaceId: string, options: StartOptions): Promise<Exclude<ConnectionAnswer, { kind: "provisioning" }>> {
  const wait = options.wait ?? sleep
  const now = options.now ?? Date.now
  for (;;) {
    const answer = await unlessCutShort(connect(workspaceId), options.settled, options.pollDeadlineMs ?? POLL_DEADLINE_MS)
    if (answer === undefined) continue
    if (answer.kind !== "provisioning") return answer
    options.onProgress?.(startProgressOf(answer, now()))
    await unlessCutShort(wait(retryDelay(answer.retryAfterMs)), options.settled)
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
