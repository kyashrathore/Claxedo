import { isAgentMessage, type AgentMessage, type SessionHarness } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { tasksErrorDetail, type ModelReference, type TasksErrorDetail } from "@claxedo/tasks"
import type { TasksRuntimeTarget } from "./session-bridge-core"

type RuntimeTarget = Pick<TasksRuntimeTarget, "request">

export async function readMessages(target: RuntimeTarget, sessionId: string): Promise<AgentMessage[] | null> {
  const response = await target.request(`/session/${encodeURIComponent(sessionId)}/message`).catch(() => undefined)
  if (!response?.ok) return null
  const body: unknown = await response.json().catch(() => undefined)
  return Array.isArray(body) ? body.filter(isAgentMessage) : null
}

/**
 * What the runtime says a session runs, or null when it does not answer. The
 * model is optional because a session may leave the harness's own selection in
 * place, and the harness alone is what rendering its transcript needs.
 */
export type SessionConfiguration = {
  harness: SessionHarness
  model: ModelReference | null
  effort: string | null
  instructions: string
}

export async function readSessionConfiguration(
  target: RuntimeTarget,
  sessionId: string,
): Promise<SessionConfiguration | null> {
  const response = await target.request(`/session/${encodeURIComponent(sessionId)}/config`).catch(() => undefined)
  if (!response?.ok) return null
  const body = asRecord(await response.json().catch(() => undefined))
  const harness = asRecord(body?.harness)
  const id = typeof harness?.id === "string" ? harness.id : undefined
  const access = harness?.access === "native" || harness?.access === "connection" ? harness.access : undefined
  if (!id || !access) return null
  const model = asRecord(body?.model)
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
  const modelID = typeof model?.modelID === "string" ? model.modelID : undefined
  return {
    harness: { id, access },
    model: providerID && modelID ? { providerID, modelID } : null,
    effort: typeof body?.variant === "string" ? body.variant : null,
    instructions: typeof body?.instructions === "string" ? body.instructions : "",
  }
}

export type SessionTimes = { created: number; updated: number }

export async function sessionTimes(response: Response): Promise<SessionTimes | undefined> {
  const time = asRecord(asRecord(await response.json().catch(() => undefined))?.time)
  const created = asFiniteNumber(time?.created)
  const updated = asFiniteNumber(time?.updated)
  return created === undefined || updated === undefined ? undefined : { created, updated }
}

export function untimedSession(sessionId: string): { ok: false; error: TasksErrorDetail } {
  return {
    ok: false,
    error: tasksErrorDetail("unsupported", `The workspace runtime answered session ${sessionId} without its creation and update times`),
  }
}

/**
 * Whether this origin's first message is already on the session. The runtime
 * does not deduplicate by `messageID`, so a retry that skipped this read would
 * send the task a second time — and a history it would not return is not the
 * same answer as a history without the message.
 */
export async function alreadySent(
  target: RuntimeTarget,
  sessionId: string,
  messageId: string,
): Promise<"present" | "absent" | "unreadable"> {
  const messages = await readMessages(target, sessionId)
  if (!messages) return "unreadable"
  return messages.some((message) => message.info.id === messageId) ? "present" : "absent"
}

export async function runtimeRefusal(operation: string, response: Response): Promise<TasksErrorDetail> {
  const error = asRecord(asRecord(await response.json().catch(() => undefined))?.error)
  const detail = typeof error?.message === "string" ? error.message : `status ${response.status}`
  return tasksErrorDetail("unsupported", `The workspace runtime refused to ${operation}: ${detail}`)
}
