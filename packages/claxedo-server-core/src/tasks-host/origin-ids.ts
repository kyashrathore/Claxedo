import { hashRequest, startOriginId, type ConfigurationSlot } from "@claxedo/tasks"

/**
 * The ids an origin decides, so two clients racing one slot and attempt
 * converge on one session and one first message instead of two of each, and a
 * handoff that runs long after the create addresses the same message.
 */
export async function originIds(input: {
  scopeId: string
  taskId: string
  slot: ConfigurationSlot
  attempt: number
}): Promise<{ origin: string; sessionId: string; messageId: string }> {
  const origin = startOriginId(input.scopeId, input.taskId, input.slot, input.attempt)
  const hash = (await hashRequest(origin)).slice(0, 32)
  return { origin, sessionId: `ses_tasks_${hash}`, messageId: `msg_tasks_${hash}` }
}
