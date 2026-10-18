import { contractMismatch, ServerError } from "./errors"
import { onRuntime, readSnapshotDatum, sessionEndpoint, type SessionContext } from "./session-context"
import { jsonInit, type RuntimeRoute } from "./transport"
import type { PromptInput, QueuedPrompt, QueuedPromptAction, QueuedPromptControl, SessionLocation } from "./types"
import { promptBody } from "./wire/prompt"
import { queuedPromptControlFromWire, queuedPromptFromWire } from "./wire/queue"

function queuePath(ref: SessionLocation, suffix = "") {
  return sessionEndpoint(ref, `/queue${suffix}`)
}

async function readQueue(context: SessionContext, where: RuntimeRoute, ref: SessionLocation): Promise<readonly QueuedPrompt[]> {
  const rows = await readSnapshotDatum(context, where, queuePath(ref), ref, "queue", "Queue")
  if (!Array.isArray(rows)) throw contractMismatch("queue")
  return rows.flatMap((row) => {
    const prompt = queuedPromptFromWire(row)
    return prompt ? [prompt] : []
  })
}

export function createSessionQueue(context: SessionContext) {
  const { transport, workspaces } = context
  return {
    queue: (ref: SessionLocation): Promise<readonly QueuedPrompt[] | undefined> => onRuntime(context, ref, (where) => readQueue(context, where, ref), async () => undefined),
    controlQueued: async (ref: SessionLocation, seq: number, action: QueuedPromptAction): Promise<QueuedPromptControl> => {
      const body = await transport.runtimeJson(await workspaces.route(ref), queuePath(ref, `/${seq}/${action}`), jsonInit("POST", {}))
      return queuedPromptControlFromWire(body)
    },
    replaceQueued: async (ref: SessionLocation, seq: number, input: PromptInput, messageId: string): Promise<boolean> => {
      try {
        await transport.runtimeJson(await workspaces.route(ref), queuePath(ref, `/${seq}/replace`), jsonInit("POST", promptBody(input, messageId)))
        return true
      } catch (error) {
        if (error instanceof ServerError && error.class === "conflict") return false
        throw error
      }
    },
  }
}
