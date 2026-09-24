import { ServerError } from "./errors"
import { sessionPath } from "./session-context"
import { jsonInit, type Transport } from "./transport"
import type { PromptInput, QueuedPrompt, QueuedPromptAction, QueuedPromptControl, SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { promptBody } from "./wire/prompt"
import { queuedPromptControlFromWire, queuedPromptFromWire } from "./wire/queue"

function queuePath(ref: SessionRef, suffix = "") {
  return sessionPath(ref, `/queue${suffix}`)
}

export function createSessionQueue(transport: Transport, workspaces: Workspaces) {
  return {
    queue: async (ref: SessionRef): Promise<readonly QueuedPrompt[]> => {
      const rows = await transport.runtimeJson<unknown[]>(await workspaces.route(ref), queuePath(ref))
      return rows.flatMap((row) => {
        const prompt = queuedPromptFromWire(row)
        return prompt ? [prompt] : []
      })
    },
    controlQueued: async (ref: SessionRef, seq: number, action: QueuedPromptAction): Promise<QueuedPromptControl> => {
      const body = await transport.runtimeJson<unknown>(await workspaces.route(ref), queuePath(ref, `/${seq}/${action}`), jsonInit("POST", {}))
      return queuedPromptControlFromWire(body)
    },
    replaceQueued: async (ref: SessionRef, seq: number, input: PromptInput, messageId: string): Promise<boolean> => {
      try {
        await transport.runtimeJson<unknown>(await workspaces.route(ref), queuePath(ref, `/${seq}/replace`), jsonInit("POST", promptBody(input, messageId)))
        return true
      } catch (error) {
        if (error instanceof ServerError && error.class === "conflict") return false
        throw error
      }
    },
  }
}
