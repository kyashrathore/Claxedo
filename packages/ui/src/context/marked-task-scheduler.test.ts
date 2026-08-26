import { expect, test } from "bun:test"
import { createLatestTaskScheduler, LatestTaskSupersededError } from "./marked-task-scheduler"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

test("coalesces streaming revisions by key and runs visible work first", async () => {
  const gate = deferred()
  const ran: string[] = []
  const queue = createLatestTaskScheduler({ maxConcurrent: 1, maxPendingBytes: 1024 })
  const first = queue.schedule({ key: "stream", bytes: 1 }, async () => {
    ran.push("first")
    await gate.promise
    return "first"
  })
  await Promise.resolve()
  const obsolete = queue.schedule({ key: "stream", bytes: 1 }, async () => "obsolete")
  const latest = queue.schedule({ key: "stream", bytes: 1 }, async () => {
    ran.push("latest")
    return "latest"
  })
  const hidden = queue.schedule({ key: "hidden", bytes: 1 }, async () => {
    ran.push("hidden")
    return "hidden"
  })
  const visible = queue.schedule({ key: "visible", priority: 1, bytes: 1 }, async () => {
    ran.push("visible")
    return "visible"
  })

  await expect(obsolete).rejects.toBeInstanceOf(LatestTaskSupersededError)
  expect(queue.inspect()).toEqual({ active: 1, pending: 3, pendingBytes: 3 })
  gate.resolve()
  await Promise.all([first, latest, hidden, visible])
  expect(ran).toEqual(["first", "visible", "latest", "hidden"])
})

test("evicts old hidden input instead of exceeding the pending byte budget", async () => {
  const gate = deferred()
  const queue = createLatestTaskScheduler({ maxConcurrent: 1, maxPendingBytes: 8 })
  const active = queue.schedule({ key: "active" }, async () => gate.promise)
  await Promise.resolve()
  const hidden = queue.schedule({ key: "hidden", bytes: 6 }, async () => "hidden")
  const visible = queue.schedule({ key: "visible", priority: 1, bytes: 6 }, async () => "visible")
  await expect(hidden).rejects.toBeInstanceOf(LatestTaskSupersededError)
  expect(queue.inspect()).toEqual({ active: 1, pending: 1, pendingBytes: 6 })
  gate.resolve()
  await active
  expect(await visible).toBe("visible")
})
