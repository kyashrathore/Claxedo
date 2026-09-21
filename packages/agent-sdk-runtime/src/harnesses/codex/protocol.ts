import type { PromptInput } from "../../index"
import { isRuntimeGoalStatus, type RawHarnessEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { codexStartedSubagent } from "@claxedo/agent-event-runtime/harnesses/codex"
import { harnessSpawnEnv } from "../shared/spawn-env"
import { asRecord } from "@claxedo/helpers/guards"
import {
  errorMessage,
  text,
  type JsonRecord,
} from "../shared/sdk-runtime-adapter"
import { createTurnStop, type TurnStopRecord } from "../shared/cancellation-facts"
import { controlRequestDeadline } from "../shared/request-deadline"
import { deliverPromptAttachments, promptImageAttachments } from "../shared/prompt-attachments"
import type { RequestDeadline } from "../../launch"
import type { CodexAppServerProcess } from "./app-server-process"

export type CodexTurnStop = {
  observe(method: string, params: JsonRecord): void
  /**
   * A property, not a method: this is a standalone closure over the turn, and
   * callers detach it — the lifecycle entry holds it as `close`, and the abort
   * handler calls it on its own. Declaring it as a method would say it needs a
   * receiver it has never had.
   */
  stop: (deadline?: RequestDeadline) => Promise<void>
  /** Where each attempt's outcome is recorded for `cancelTurn` to read. */
  readonly record: TurnStopRecord
}

/**
 * Cancel generation and terminate only the command processes this turn owns.
 *
 * One attempt runs at a time and a completed one is not repeated, but a
 * rejected attempt is kept only as evidence: a stop that never reached the
 * provider has established nothing, so the next caller gets a new request
 * rather than the old rejection.
 */
export function createCodexTurnStop(input: {
  process: Pick<CodexAppServerProcess, "request">
  threadId: string
  turnId: () => Promise<string> | string
  record: TurnStopRecord
}): CodexTurnStop {
  const commandProcesses = new Map<string, Set<string>>()
  /**
   * The threads this turn is answerable for: its own, and every subagent
   * thread started beneath one of them. A command on an unrelated thread
   * belongs to whoever started it.
   */
  const ownedThreads = new Set([input.threadId])

  const attempt = async (parent: RequestDeadline | undefined) => {
    const turnId = await input.turnId()
    if (!turnId) return
    await input.process.request("turn/interrupt", { threadId: input.threadId, turnId }, controlRequestDeadline(parent))
    const ours = commandProcesses.get(turnId) ?? new Set<string>()
    const children = [...ownedThreads].filter((threadId) => threadId !== input.threadId)
    if (!ours.size && !children.length) {
      // This turn started no command and spawned no thread, so Codex holds
      // nothing of its own to enumerate.
      input.record.cleanup = "verified_clear"
      return
    }
    let remaining = await survivors(ours, children, parent)
    if (remaining.length) {
      input.record.cleanup = "owned"
      for (const { threadId, processId } of remaining) {
        await input.process.request("thread/backgroundTerminals/terminate", { threadId, processId }, controlRequestDeadline(parent))
      }
      // An acknowledged terminate is a promise; the inventory read back
      // without them is the proof.
      remaining = await survivors(ours, children, parent)
    }
    input.record.cleanup = remaining.length ? "owned" : "verified_clear"
  }

  /**
   * Every terminal this turn is answerable for, across the threads it owns.
   *
   * The parent thread carries other turns' terminals too, so only the command
   * processes this turn was seen starting count there. A subagent thread
   * exists solely for this turn, so everything on its inventory is this turn's
   * — including a command this owner never watched start.
   */
  const survivors = async (ours: Set<string>, children: string[], parent: RequestDeadline | undefined) => {
    const found: Array<{ threadId: string; processId: string }> = []
    for (const threadId of [input.threadId, ...children]) {
      const mine = threadId === input.threadId ? ours : undefined
      for (const processId of await listTerminals(threadId, parent)) {
        if (!mine || mine.has(processId)) found.push({ threadId, processId })
      }
    }
    return found
  }

  /**
   * One thread's terminals, across every page. A list this owner could not
   * read leaves cleanup unknown rather than clear: the absence of an answer is
   * not an empty inventory.
   */
  const listTerminals = async (threadId: string, parent: RequestDeadline | undefined) => {
    const ids: string[] = []
    let cursor: string | undefined
    try {
      do {
        // A fresh budget per page. One instant shared across the interrupt,
        // every page and every terminate would expire partway through a stop
        // that is answering perfectly well.
        const response = asRecord(await input.process.request("thread/backgroundTerminals/list", { threadId, ...(cursor ? { cursor } : {}) }, controlRequestDeadline(parent)))
        if (!Array.isArray(response?.data)) throw new Error("Codex returned an invalid background terminal list")
        for (const terminal of response.data) {
          const processId = text(asRecord(terminal)?.processId)
          if (processId) ids.push(processId)
        }
        cursor = text(response?.nextCursor)
      } while (cursor)
    } catch (error) {
      input.record.cleanup = "unknown"
      throw error
    }
    return ids
  }

  return {
    record: input.record,
    observe(method: string, params: JsonRecord) {
      if (method === "thread/started") {
        const started = codexStartedSubagent(params)
        if (started && ownedThreads.has(started.parentThreadId)) ownedThreads.add(started.id)
        return
      }
      const item = asRecord(params.item)
      if (item?.type !== "commandExecution") return
      const processId = text(item.processId)
      const threadId = text(params.threadId)
      // A subagent thread's terminals are read off that thread's own
      // inventory at stop time, so nothing is recorded for them here: a set
      // that only ever grows would pin this turn at `owned` for good.
      if (!processId || threadId !== input.threadId) return
      const turnId = text(params.turnId)
      if (!turnId) return
      const processes = commandProcesses.get(turnId) ?? new Set<string>()
      processes.add(processId)
      commandProcesses.set(turnId, processes)
    },
    stop: createTurnStop(input.record, "provider_unreachable", (deadline) => attempt(deadline)),
  }
}

/**
 * Hands another user message to the turn already running on this thread.
 *
 * `expectedTurnId` is a precondition the app-server enforces, so a steer that
 * loses the race with the turn's completion fails instead of starting a turn
 * nobody asked for. Steering a review or compact turn is refused the same way
 * (`activeTurnNotSteerable`).
 */
export async function codexSteerTurn(steer: {
  process: Pick<CodexAppServerProcess, "request">
  threadId: string
  turnId: string | undefined
  input: PromptInput
  directory: string
}) {
  if (!steer.turnId) return { ok: false as const, status: "no_active_turn" as const, message: "Codex has no active turn id to steer" }
  await steer.process.request("turn/steer", {
    threadId: steer.threadId,
    input: await codexUserInput({ parts: steer.input.parts, directory: steer.directory }),
    expectedTurnId: steer.turnId,
    clientUserMessageId: steer.input.userMessageId,
  }, controlRequestDeadline())
  return { ok: true as const }
}

export type { CodexActiveThread } from "./active-thread"

export function codexIdleTimeoutMs() {
  const configured = Number(process.env.CLAXEDO_CODEX_IDLE_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? Math.round(configured) : 30_000
}

export const CODEX_DYNAMIC_TOOLS = [{
  name: "spawn_agent",
  description: "Spawn a child Codex agent to execute one bounded task.",
  inputSchema: {
    type: "object",
    properties: {
      task_name: { type: "string", description: "Short stable name for the child task." },
      message: { type: "string", description: "Task instructions for the child agent." },
    },
    required: ["task_name", "message"],
    additionalProperties: false,
  },
}]

export class GoalTurnEventQueue implements AsyncIterable<RawHarnessEvent> {
  private values: RawHarnessEvent[] = []
  private waiters: Array<() => void> = []
  private ended = false

  push(event: RawHarnessEvent) {
    if (this.ended) return
    this.values.push(event)
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  end() {
    this.ended = true
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const value = this.values.shift()
      if (value) yield value
      else if (this.ended) return
      else await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }
}

export function codexGoalSnapshot(sessionId: string, value: unknown): RuntimeGoalSnapshot {
  const goal = asRecord(value)
  const objective = text(goal?.objective)
  const status = text(goal?.status)
  if (!goal || !objective || !status) throw new Error("Codex app-server returned an invalid Goal")
  const normalizedStatus = status === "usageLimited" || status === "budgetLimited" ? "limited" : status
  if (!isRuntimeGoalStatus(normalizedStatus)) {
    throw new Error(`Codex app-server returned unknown Goal status '${status}'`)
  }
  return {
    sessionId,
    objective,
    status: normalizedStatus,
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : Date.now(),
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : Date.now(),
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {}),
    ...(typeof goal.tokensUsed === "number" ? { tokensUsed: goal.tokensUsed } : {}),
    ...(typeof goal.timeUsedSeconds === "number" ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
  }
}

export function isThreadNotFound(err: unknown): boolean {
  return /thread not found/i.test(errorMessage(err))
}

const MAX_THREAD_RESUME_ATTEMPTS = 2

export function sessionLostMessage(cause: unknown): string {
  return `The agent process no longer has this conversation (session not found). ${errorMessage(cause)}`
}

export async function startTurnWithThreadRecovery(input: {
  startTurn: () => Promise<JsonRecord>
  resumeThread: () => Promise<unknown>
}): Promise<JsonRecord> {
  try {
    return await input.startTurn()
  } catch (err) {
    if (!isThreadNotFound(err)) throw err
    let lastError = err
    for (let attempt = 0; attempt < MAX_THREAD_RESUME_ATTEMPTS; attempt++) {
      await input.resumeThread()
      try {
        return await input.startTurn()
      } catch (retryErr) {
        if (!isThreadNotFound(retryErr)) throw retryErr
        lastError = retryErr
      }
    }
    throw new Error(sessionLostMessage(lastError), { cause: err })
  }
}

export function codexSpawnEnv(input: Record<string, string | undefined>) {
  return harnessSpawnEnv(input)
}

/**
 * The `turn/start` input: the prompt text, then one `localImage` per image
 * attachment.
 *
 * `localImage` takes the workspace path the attachment was written to, which is
 * the same path the text already names — Codex renders the picture from it and
 * the model can still read the file with its own tools. Codex has no input for
 * any other attachment type, so those reach it through their path line alone.
 */
export async function codexUserInput(input: { parts: readonly unknown[]; directory: string }) {
  const delivery = await deliverPromptAttachments(input)
  return [
    { type: "text", text: delivery.text, text_elements: [] },
    ...promptImageAttachments(delivery).map((attachment) => ({ type: "localImage", path: attachment.path })),
  ]
}

export function codexAppServerModel(model: string | undefined) {
  const value = text(model)
  if (!value || value === "default") return undefined
  return value
}

export function codexTurnModel(input: PromptInput, configuredModel: string) {
  return codexAppServerModel(text(input.model?.modelID) ?? text(configuredModel))
}
