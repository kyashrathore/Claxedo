import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId, type QueuedPrompt, type QueuedPromptAction, type QueuedPromptPart, type Server } from "@/server"
import type { SessionView } from "@/session"
import { createQueue } from "../transcript/queue"

void mock.module("@/composer", () => ({
  sessionComposerKey: (ref: { sessionId: string }) => `session:${ref.sessionId}`,
  queuedDraft: ({ parts }: { parts: QueuedPromptPart[] }) => (parts.every((part) => part.text !== undefined) ? { prompt: parts.map((part) => ({ content: part.text })) } : undefined),
}))
const { createQueueEdit } = await import("./queue-edit")

const REF = { projectId: projectId("p"), placementId: placementId("w"), sessionId: sessionId("s") }
const RECORD: QueuedPrompt = { seq: 1, messageId: "m", queuedAt: 1, held: false, parts: [{ type: "text", text: "Queued original" }] }

function arrange(parts = RECORD.parts) {
  let rows: QueuedPrompt[] | undefined = [{ ...RECORD, parts }]
  const actions: QueuedPromptAction[] = []
  const server = {
    sessions: {
      queue: async () => rows,
      controlQueued: async (_ref: unknown, _seq: number, action: QueuedPromptAction) => {
        actions.push(action)
        return { ok: true }
      },
      replaceQueued: async () => true,
    },
  } as unknown as Server
  const drafts = { key: "", fork: undefined as string | undefined, kept: [] as string[] }
  const store = {
    forkDraft: (key: string, draft: { prompt: Array<{ content: string }> }) => {
      drafts.key = key
      drafts.fork = draft.prompt[0]?.content
    },
    joinFork: () => {
      if (drafts.fork !== undefined) drafts.kept.push(drafts.fork)
      drafts.fork = undefined
    },
    dropFork: () => {
      drafts.fork = undefined
    },
  }
  const { queue, edit } = createRoot(() => {
    const queue = createQueue(server, REF, () => undefined)
    const view = { ref: REF, queue, replaceQueued: queue.replace } as unknown as SessionView
    return { queue, edit: createQueueEdit(view, store as never) }
  })
  const begin = async () => {
    await queue.reread()
    edit.queued.beginEdit(queue.items()[0])
    await Bun.sleep(0)
  }
  return { queue, edit, actions, drafts, begin, remove: () => (rows = []), unreachable: () => (rows = undefined), reachable: () => (rows = [{ ...RECORD, parts, held: true }]) }
}

test("editing a queued message forks the session draft with the record's content", async () => {
  const { queue, drafts, begin } = arrange()
  await begin()
  expect(queue.editing()).toBe(1)
  expect(drafts).toEqual({ key: "session:s", fork: "Queued original", kept: [] })
})

test("a queued message that disappears while it is edited ends the edit and keeps the edited text", async () => {
  const { queue, edit, drafts, begin, remove } = arrange()
  await begin()
  drafts.fork = "Edited"
  remove()
  await queue.reread()
  expect(queue.editing()).toBeUndefined()
  expect(edit.edit.active()).toBe(false)
  expect(drafts.fork).toBeUndefined()
  expect(drafts.kept).toEqual(["Edited"])
})

test("an edit stays open while the session's runtime is unreachable and its record is unknown", async () => {
  const { queue, edit, drafts, actions, begin, unreachable, reachable } = arrange()
  await begin()
  drafts.fork = "Edited"
  unreachable()
  await queue.reread()
  expect(queue.editing()).toBe(1)
  expect(queue.items().map((item) => item.seq)).toEqual([1])
  expect(drafts).toMatchObject({ fork: "Edited", kept: [] })
  reachable()
  await queue.reread()
  edit.edit.cancel()
  await Bun.sleep(0)
  expect(actions).toEqual(["hold", "release"])
  expect(drafts).toMatchObject({ fork: undefined, kept: [] })
})

test("cancelling or saving an edit discards its fork", async () => {
  const { edit, drafts, actions, begin } = arrange()
  await begin()
  edit.edit.cancel()
  await Bun.sleep(0)
  expect(actions).toEqual(["hold", "release"])
  expect(drafts.fork).toBeUndefined()
  await begin()
  expect(drafts.fork).toBe("Queued original")
  expect(await edit.edit.replace({ clientRequestId: "c", text: "Saved", attachments: [] })).toBe(true)
  expect(drafts.fork).toBeUndefined()
  expect(drafts.kept).toEqual([])
})

test("a queued message the composer cannot restore is refused before it is held", async () => {
  const { queue, drafts, actions, begin } = arrange([{ type: "file", filename: "missing-content" }])
  await begin()
  expect(actions).toEqual([])
  expect(queue.editing()).toBeUndefined()
  expect(queue.error()).toBe("This queued attachment cannot be edited")
  expect(drafts.fork).toBeUndefined()
})
