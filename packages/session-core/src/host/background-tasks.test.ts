import { expect, test } from "bun:test"
import type { BackgroundTaskOperations, HarnessSession } from "@claxedo/harness/contract"
import type { UnattachedRead } from "./attachments"
import { createBackgroundTaskStops } from "./background-tasks"

const session = { binding: { sessionId: "s1" } } as HarnessSession

function reading(backgroundTasks: BackgroundTaskOperations | undefined, attached: boolean) {
  const read = { handle: { runner: { id: "claude" }, transport: { backgroundTasks } }, directory: "/work",
    ...(attached ? { attached: { session } } : {}) } as unknown as UnattachedRead
  return { withoutAttaching: async () => read }
}

test("a session that holds no harness process has no background task to stop, and the harness is not asked", async () => {
  let asked = 0
  const stops = createBackgroundTaskStops(reading({ stop: async () => { asked++; return { ok: true } } }, false))
  expect(await stops.stop("s1", { toolCallId: "call-1" })).toMatchObject({ ok: false, status: "not_found" })
  expect(asked).toBe(0)
})

test("a held session's stop goes to its harness session, and a harness without the operation is unsupported", async () => {
  const seen: unknown[] = []
  const stops = createBackgroundTaskStops(reading({ stop: async (target, task) => { seen.push([target, task]); return { ok: true } } }, true))
  expect(await stops.stop("s1", { toolCallId: "call-1" })).toEqual({ ok: true })
  expect(seen).toEqual([[session, { toolCallId: "call-1" }]])
  expect(await createBackgroundTaskStops(reading(undefined, true)).stop("s1", { toolCallId: "call-1" }))
    .toEqual({ ok: false, status: "unsupported", harness: "claude" })
})
