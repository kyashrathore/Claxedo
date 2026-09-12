import type { PromptDelivery } from "@claxedo/agent-sdk-runtime"
import type { SessionPromptBody } from "../session/service"
import type { QueuedPromptRecord } from "../store"

/** Who asked for the prompt, carried so a recovered turn runs as them. */
export type QueuedPromptRequester = Pick<QueuedPromptRecord, "actor" | "author">

/** The durable queued-prompt rows, plus the session row that owns the directory. */
export type QueuedPromptStore = {
  queuePrompt(input: Omit<QueuedPromptRecord, "seq" | "queuedAt">): QueuedPromptRecord
  deleteQueuedPrompt(sessionId: string, seq: number): void
  listQueuedPrompts(): QueuedPromptRecord[]
  sessionDirectory(sessionId: string): string | undefined
}

export type QueuedPromptHost = {
  /**
   * Persist a prompt the runtime is holding behind a running turn. The returned
   * handle is released by the caller once the prompt becomes a turn.
   */
  queue(input: { sessionId: string; body: SessionPromptBody } & QueuedPromptRequester): { release: () => void }
  /** Re-issues every prompt still queued, once, after a restart. */
  recover(): Promise<void>
}

export function createQueuedPromptHost(input: {
  /**
   * Resolved per call, not held: the host builds its store on the request
   * path, and `undefined` is a store that cannot persist queued prompts — the
   * queue then lives in the request holding the prompt, as it did before.
   */
  store: () => QueuedPromptStore | undefined
  startTurn: (input: {
    sessionId: string
    directory: string
    body: SessionPromptBody
    onDelivery: (delivery: PromptDelivery) => void
  } & QueuedPromptRequester) => Promise<unknown>
}): QueuedPromptHost {
  let recovered: Promise<void> | undefined
  const release = (row: Pick<QueuedPromptRecord, "sessionId" | "seq">) =>
    input.store()?.deleteQueuedPrompt(row.sessionId, row.seq)
  return {
    queue({ sessionId, body, actor, author }) {
      const store = input.store()
      if (!store) return { release: () => {} }
      const record = store.queuePrompt({
        sessionId,
        ...queuedPromptColumns(body),
        ...(actor ? { actor } : {}),
        ...(author ? { author } : {}),
      })
      return { release: () => release(record) }
    },
    recover() {
      recovered ??= (async () => {
        const store = input.store()
        if (!store) return
        for (const row of store.listQueuedPrompts()) {
          const directory = store.sessionDirectory(row.sessionId)
          // The session row owns the directory, and it is deleted with the
          // session: a prompt with no session left has nowhere to run.
          if (!directory) {
            release(row)
            continue
          }
          let decided = false
          await input.startTurn({
            sessionId: row.sessionId,
            directory,
            body: queuedPromptBody(row),
            ...(row.actor ? { actor: row.actor } : {}),
            ...(row.author ? { author: row.author } : {}),
            // A prompt that is queued again is still waiting, so its row stays
            // durable until the turn it becomes actually starts.
            onDelivery: (delivery) => {
              decided = true
              if (delivery !== "queue") release(row)
            },
          })
          // The runtime never took this prompt, so nothing is waiting for it
          // here and the row would be re-issued by every later boot.
          if (!decided) release(row)
        }
      })().catch((error) => {
        console.error("queued prompt recovery failed", error)
      })
      return recovered
    },
  }
}

function queuedPromptColumns(body: SessionPromptBody): Omit<QueuedPromptRecord, "sessionId" | "seq" | "queuedAt" | "actor" | "author"> {
  return {
    parts: body.parts ?? [],
    ...(body.messageID ? { messageId: body.messageID } : {}),
    ...(body.agent ? { agent: body.agent } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.format ? { format: body.format } : {}),
    ...(body.system ? { system: body.system } : {}),
    ...(body.variant === undefined ? {} : { variant: body.variant }),
    ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
    delivery: body.delivery ?? "queue",
  }
}

function queuedPromptBody(row: QueuedPromptRecord): SessionPromptBody {
  return {
    parts: row.parts,
    ...(row.messageId ? { messageID: row.messageId } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.tools ? { tools: row.tools } : {}),
    ...(row.format ? { format: row.format } : {}),
    ...(row.system ? { system: row.system } : {}),
    ...(row.variant === undefined ? {} : { variant: row.variant }),
    ...(row.permissionMode ? { permissionMode: row.permissionMode } : {}),
    delivery: row.delivery,
  }
}
