import type { PromptDelivery } from "@claxedo/agent-sdk-runtime"
import type { QueuedPromptAction, SessionPromptBody } from "../session/service"
import type { QueuedPromptRecord } from "../store"

/** Who asked for the prompt, carried so a recovered turn runs as them. */
export type QueuedPromptRequester = Pick<QueuedPromptRecord, "actor" | "author">

/** The durable queued-prompt rows, plus the session row that owns the directory. */
export type QueuedPromptStore = {
  queuePrompt(input: Omit<QueuedPromptRecord, "seq" | "queuedAt">): QueuedPromptRecord
  deleteQueuedPrompt(sessionId: string, seq: number): void
  replaceQueuedPromptParts(sessionId: string, seq: number, parts: QueuedPromptRecord["parts"]): boolean
  listQueuedPrompts(): QueuedPromptRecord[]
  sessionDirectory(sessionId: string): string | undefined
}

export type QueuedPromptHandle = {
  release: () => void
  clearAction: () => void
  action: () => Promise<QueuedPromptAction>
}

export type QueuedPromptHost = {
  list(sessionId: string): Array<QueuedPromptRecord & { held: boolean }>
  control(sessionId: string, seq: number, action: QueuedPromptAction): boolean
  /**
   * Persist a prompt the runtime is holding behind a running turn. The returned
   * handle is released by the caller once the prompt becomes a turn.
   */
  queue(input: { sessionId: string; body: SessionPromptBody } & QueuedPromptRequester): QueuedPromptHandle
  /**
   * Re-issues every prompt still queued, once, after a restart. Safe to call
   * from each signal that the runtime can start a turn: a pass that already
   * re-issued a row deleted it, and a pass that failed re-issued nothing.
   */
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
    queuedAction?: () => Promise<QueuedPromptAction>
    onQueuedWaitEnd?: () => void
  } & QueuedPromptRequester) => Promise<unknown>
}): QueuedPromptHost {
  const controls = new Map<string, (action: QueuedPromptAction) => void>()
  // Holds live with the process, not the row: a restart re-issues every row
  // unheld, and the edit that held it is gone with the client's page anyway.
  const held = new Set<string>()
  const key = (sessionId: string, seq: number) => `${sessionId}:${seq}`
  const handle = (row: QueuedPromptRecord): QueuedPromptHandle => ({
    release: () => { controls.delete(key(row.sessionId, row.seq)); held.delete(key(row.sessionId, row.seq)); release(row) },
    clearAction: () => controls.delete(key(row.sessionId, row.seq)),
    action: () => new Promise((resolve) => controls.set(key(row.sessionId, row.seq), resolve)),
  })
  let recovered: Promise<void> | undefined
  const release = (row: Pick<QueuedPromptRecord, "sessionId" | "seq">) =>
    input.store()?.deleteQueuedPrompt(row.sessionId, row.seq)
  return {
    list: (sessionId) => (input.store()?.listQueuedPrompts() ?? [])
      .filter((row) => row.sessionId === sessionId)
      .map((row) => ({ ...row, held: held.has(key(row.sessionId, row.seq)) })),
    control(sessionId, seq, action) {
      const control = controls.get(key(sessionId, seq))
      if (!control) return false
      // The durable row changes before the waiting turn does, so a restart
      // between the two re-issues the edited prompt, never the old one.
      if (typeof action === "object" && !input.store()?.replaceQueuedPromptParts(sessionId, seq, action.replace)) return false
      if (action === "hold") held.add(key(sessionId, seq))
      else held.delete(key(sessionId, seq))
      controls.delete(key(sessionId, seq))
      control(action)
      return true
    },
    queue({ sessionId, body, actor, author }) {
      const store = input.store()
      if (!store) return { release: () => {}, clearAction: () => {}, action: () => new Promise(() => {}) }
      const record = store.queuePrompt({
        sessionId,
        ...queuedPromptColumns(body),
        ...(actor ? { actor } : {}),
        ...(author ? { author } : {}),
      })
      return handle(record)
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
          const pending = handle(row)
          let decided = false
          await input.startTurn({
            sessionId: row.sessionId,
            directory,
            body: queuedPromptBody(row),
            ...(row.actor ? { actor: row.actor } : {}),
            ...(row.author ? { author: row.author } : {}),
            // A prompt that is queued again is still waiting, so its row stays
            // durable until the turn it becomes actually starts.
            onQueuedWaitEnd: pending.clearAction,
            queuedAction: async () => {
              const action = await pending.action()
              if (action === "cancel") pending.release()
              return action
            },
            onDelivery: (delivery) => {
              decided = true
              if (delivery !== "queue") pending.release()
            },
          })
          // The runtime never took this prompt, so nothing is waiting for it
          // here and the row would be re-issued by every later boot.
          if (!decided) release(row)
        }
      })().catch((error) => {
        // The runtime could not take the row this pass stopped on — it has no
        // harness yet, most often — so the pass does not count as having run.
        recovered = undefined
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
