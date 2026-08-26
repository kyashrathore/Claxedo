import { expect, test } from "bun:test"
import { createLatestWorkerQueue } from "./markdown-worker-queue"

test("keeps only the latest queued request for each key", async () => {
  const processed: number[] = []
  const superseded: number[] = []
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const queue = createLatestWorkerQueue<{ id: number; key: string }>({
    run: async (request) => {
      processed.push(request.id)
      if (request.id === 1) await blocked
    },
    supersede: (request) => superseded.push(request.id),
    dispose: () => {},
  })

  queue.highlight({ id: 1, key: "code" })
  await Promise.resolve()
  queue.highlight({ id: 2, key: "code" })
  queue.highlight({ id: 3, key: "code" })
  queue.highlight({ id: 4, key: "code" })

  expect(queue.pending()).toBe(1)
  expect(superseded).toEqual([2, 3])
  release()
  await queue.idle()
  expect(processed).toEqual([1, 4])
})

test("serializes disposal before a later request for the same key", async () => {
  const events: string[] = []
  const queue = createLatestWorkerQueue<{ id: number; key: string }>({
    run: async (request) => {
      events.push(`highlight:${request.id}`)
    },
    supersede: (request) => events.push(`supersede:${request.id}`),
    dispose: (key) => events.push(`dispose:${key}`),
  })

  queue.highlight({ id: 1, key: "code" })
  queue.dispose("code")
  queue.highlight({ id: 2, key: "code" })
  await queue.idle()

  expect(events).toEqual(["supersede:1", "dispose:code", "highlight:2"])
})


test("prioritizes visible keys without allowing a later highlight to pass its disposal", async () => {
  const events: string[] = []
  let release = () => {}
  const blocked = new Promise<void>((resolve) => (release = resolve))
  const queue = createLatestWorkerQueue<{ id: number; key: string; priority?: number }>({
    run: async (request) => {
      events.push(`highlight:${request.id}`)
      if (request.id === 1) await blocked
    },
    supersede: (request) => events.push(`supersede:${request.id}`),
    dispose: (key) => events.push(`dispose:${key}`),
  })
  queue.highlight({ id: 1, key: "active" })
  await Promise.resolve()
  queue.highlight({ id: 2, key: "hidden" })
  queue.dispose("reuse")
  queue.highlight({ id: 3, key: "reuse", priority: 10 })
  queue.highlight({ id: 4, key: "visible", priority: 1 })
  release()
  await queue.idle()
  expect(events).toEqual(["highlight:1", "dispose:reuse", "highlight:3", "highlight:4", "highlight:2"])
})

test("bounds distinct queued keys by input bytes", async () => {
  const superseded: number[] = []
  let release = () => {}
  const blocked = new Promise<void>((resolve) => (release = resolve))
  const queue = createLatestWorkerQueue<{ id: number; key: string; text: string; priority?: number }>({
    run: async (request) => {
      if (request.id === 1) await blocked
    },
    supersede: (request) => superseded.push(request.id),
    dispose: () => {},
    bytes: (request) => request.text.length,
    maxPendingBytes: 8,
  })
  queue.highlight({ id: 1, key: "active", text: "" })
  await Promise.resolve()
  queue.highlight({ id: 2, key: "hidden", text: "123456" })
  queue.highlight({ id: 3, key: "visible", text: "123456", priority: 1 })
  expect(superseded).toEqual([2])
  expect(queue.pendingBytes()).toBe(6)
  release()
  await queue.idle()
})
