/// <reference types="bun" />
import { expect, test } from "bun:test"
import { sessionEndpoint } from "./session-context"
import { createSessionQueue } from "./session-queue"
import { fakeServer, ref } from "./test-session-server"

test("session queue: a reachable machine reports its queued prompts, and an unreachable one reports the queue as unknown", async () => {
  const queued = [{ seq: 1, messageId: "m", queuedAt: 1, held: true, parts: [{ type: "text", text: "Later" }] }]
  const live = fakeServer({ reachable: () => true, machine: true, runtime: () => Response.json(queued) })
  expect(await createSessionQueue(live.context).queue(ref)).toEqual(queued)
  expect(live.runtimeCalls).toEqual([sessionEndpoint(ref, "/queue")])

  const offline = fakeServer({ reachable: () => false, machine: true })
  expect(await createSessionQueue(offline.context).queue(ref)).toBeUndefined()
  expect(offline.runtimeCalls).toEqual([])
})
