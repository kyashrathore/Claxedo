/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId, projectId, sessionId, type QueuedPrompt, type Server } from "@/server"
import { createQueue } from "./queue"

const REF = { projectId: projectId("p"), placementId: placementId("w"), sessionId: sessionId("s") }
const DISPATCHING: QueuedPrompt = { seq: 1, messageId: "m", queuedAt: 1, held: false, parts: [{ type: "text", text: "Reply only QUEUED-52." }], steering: { mode: "start", operationId: "op", state: "dispatching" } }

function queueOver(answer: () => Promise<readonly QueuedPrompt[]>) {
  const read: (readonly QueuedPrompt[])[] = []
  const server = { sessions: { queue: answer } } as unknown as Server
  const queue = createRoot(() => createQueue(server, REF, (items) => read.push(items)))
  return { queue, read }
}

test("a queue change the runtime pushes is shown at once, with no read of the queue", () => {
  let reads = 0
  const { queue, read } = queueOver(async () => { reads++; return [DISPATCHING] })
  queue.receive([])
  expect(queue.items()).toEqual([])
  expect(read).toEqual([[]])
  expect(reads).toBe(0)
})

test("a queue read that was asked before a pushed change and answers after it does not bring the older rows back", async () => {
  let answer = (_rows: readonly QueuedPrompt[]) => {}
  const { queue } = queueOver(() => new Promise((resolve) => { answer = resolve }))
  const reading = queue.reread()
  queue.receive([])
  answer([DISPATCHING])
  await reading
  expect(queue.items()).toEqual([])
})
