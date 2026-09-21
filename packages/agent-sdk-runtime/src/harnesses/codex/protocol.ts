import type { PromptInput } from "../../index"
import { isRuntimeGoalStatus, type RawHarnessEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { harnessSpawnEnv } from "../shared/spawn-env"
import { asRecord } from "@claxedo/helpers/guards"
import {
  errorMessage,
  text,
  type JsonRecord,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import { createTurnStop, type TurnStopRecord } from "../shared/cancellation-facts"
import { controlRequestDeadline } from "../shared/request-deadline"
import { deliverPromptAttachments, promptImageAttachments } from "../shared/prompt-attachments"
import type { RequestDeadline } from "../../launch"
import type { CodexAppServerProcess } from "./app-server-process"

export type CodexTurnStop = {
  observe(params: JsonRecord): void
  stop(deadline?: RequestDeadline): Promise<void>
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

  const attempt = async (deadline: RequestDeadline) => {
    const turnId = await input.turnId()
    if (!turnId) return
    await input.process.request("turn/interrupt", { threadId: input.threadId, turnId }, deadline)
    const processes = commandProcesses.get(turnId)
    if (!processes?.size) {
      // This turn started no command, and Codex runs its tools nowhere else.
      input.record.cleanup = "verified_clear"
      return
    }
    const remaining = await survivors(processes, deadline)
    if (remaining.size) {
      input.record.cleanup = "owned"
      for (const processId of remaining) {
        await input.process.request("thread/backgroundTerminals/terminate", { threadId: input.threadId, processId }, deadline)
      }
    }
    // Codex's own terminal inventory is the authority on what this turn still
    // holds, so an inventory with none of them left is proof, where an
    // acknowledged terminate on its own would only be a promise.
    input.record.cleanup = (await survivors(processes, deadline)).size ? "owned" : "verified_clear"
  }

  /** This turn's command processes that Codex still lists, across every page. */
  const survivors = async (processes: Set<string>, deadline: RequestDeadline) => {
    const remaining = new Set<string>()
    let cursor: string | undefined
    do {
      const response = asRecord(await input.process.request("thread/backgroundTerminals/list", { threadId: input.threadId, ...(cursor ? { cursor } : {}) }, deadline))
      if (!Array.isArray(response?.data)) throw new Error("Codex returned an invalid background terminal list")
      for (const terminal of response.data) {
        const processId = text(asRecord(terminal)?.processId)
        if (processId && processes.has(processId)) remaining.add(processId)
      }
      cursor = text(response?.nextCursor)
    } while (cursor)
    return remaining
  }

  return {
    record: input.record,
    observe(params: JsonRecord) {
      if (params.threadId !== input.threadId) return
      const item = asRecord(params.item)
      if (item?.type !== "commandExecution") return
      const processId = text(item.processId)
      const turnId = text(params.turnId)
      if (!processId || !turnId) return
      const processes = commandProcesses.get(turnId) ?? new Set<string>()
      processes.add(processId)
      commandProcesses.set(turnId, processes)
    },
    stop: createTurnStop(input.record, "provider_unreachable", (deadline) => attempt(controlRequestDeadline(deadline))),
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
