import { expect, test } from "bun:test"
import { AcpStartupDeadline } from "./deadline"

function clock() {
  const timers = new Map<number, () => void>()
  let id = 0
  return { timers, now: () => 0, setTimeout: (callback: () => void) => {
    const next = ++id
    timers.set(next, callback)
    return next
  }, clearTimeout: (value: unknown) => { timers.delete(value as number) },
    fire: () => { for (const [key, callback] of timers) { timers.delete(key); callback() } } }
}

test("a startup question suspends the ACP deadline until answered", async () => {
  const time = clock()
  const startup = new AcpStartupDeadline(time, 10, "session/new")
  let resolve!: (value: string) => void
  const request = new Promise<string>((done) => { resolve = done })
  const running = startup.run(request)
  const release = startup.hold()
  expect(time.timers.size).toBe(0)
  time.fire()
  release()
  expect(time.timers.size).toBe(1)
  resolve("session")
  expect(await running).toBe("session")
  expect(time.timers.size).toBe(0)
})

test("unattended startup times out without creating a session", async () => {
  const time = clock()
  const startup = new AcpStartupDeadline(time, 10, "session/new")
  const running = startup.run(new Promise<never>(() => {}))
  time.fire()
  await expect(running).rejects.toThrow("session/new timed out")
})
