import type { PromptInput } from "../../index"
import { isRuntimeGoalStatus, type RawHarnessEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import { harnessSpawnEnv } from "../shared/spawn-env"
import {
  errorMessage,
  extractTextFromParts,
  record,
  text,
  type JsonRecord,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import type { CodexAppServerProcess } from "./app-server-process"

export type CodexActiveThread = {
  sessionId: string
  agentSessionId: string
  directory: string
  model?: string
  effort?: string
  process: CodexAppServerProcess
  project: (method: string, payload: JsonRecord, frame: unknown) => void
  observeSubagent: SdkRuntimeTurnInput["observeSubagent"]
}

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
  const goal = record(value)
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
    throw new Error(sessionLostMessage(lastError))
  }
}

export function codexSpawnEnv(input: Record<string, string | undefined>) {
  return harnessSpawnEnv(input)
}

export function codexUserInput(parts: unknown[]) {
  const textInput = extractTextFromParts(parts)
  if (!textInput) return [{ type: "text", text: "", text_elements: [] }]
  return [{ type: "text", text: textInput, text_elements: [] }]
}

export function codexAppServerModel(model: string | undefined) {
  const value = text(model)
  if (!value || value === "default") return
  return value
}

export function codexTurnModel(input: PromptInput, configuredModel: string) {
  return codexAppServerModel(text(input.model.modelID) ?? text(configuredModel))
}

export function questionIds(params: JsonRecord) {
  const list = Array.isArray(params.questions) ? params.questions : []
  return list.flatMap((question) => text(record(question)?.id) ?? [])
}

export function permissionResponse(
  method: string,
  decision: "allow_once" | "allow_always" | "deny" | "reject_always",
  params: JsonRecord,
) {
  const allow = decision === "allow_once" || decision === "allow_always"
  const session = decision === "allow_always"
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: allow ? session ? "approved_for_session" : "approved" : decision === "deny" ? "denied" : "abort" }
  }
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: allow ? (record(params.permissions) ?? {}) : {},
      scope: session ? "session" : "turn",
    }
  }
  return { decision: allow ? session ? "acceptForSession" : "accept" : decision === "deny" ? "decline" : "cancel" }
}
