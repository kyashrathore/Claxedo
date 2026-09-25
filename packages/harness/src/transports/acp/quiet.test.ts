import { expect, test } from "bun:test"
import { AcpQuiet } from "./quiet"

function clock() {
  const timers = new Map<number, () => void>()
  let next = 0
  return { timers, now: () => 0, setTimeout: (callback: () => void) => {
    const id = ++next
    timers.set(id, callback)
    return id
  }, clearTimeout: (id: unknown) => { timers.delete(id as number) },
    fire: () => { for (const [id, callback] of timers) { timers.delete(id); callback() } } }
}

test("ACP activity resets the quiet deadline", () => {
  const time = clock()
  let expired = 0
  const quiet = new AcpQuiet(time, 10, () => { expired++ })
  const first = [...time.timers.keys()][0]
  quiet.touch()
  expect(time.timers.has(first!)).toBe(false)
  time.fire()
  expect(expired).toBe(1)
  quiet.dispose()
})

test("a human-held permission pauses the deadline and release starts a fresh one", () => {
  const time = clock()
  let expired = 0
  const quiet = new AcpQuiet(time, 10, () => { expired++ })
  const release = quiet.hold()
  expect(time.timers.size).toBe(0)
  time.fire()
  expect(expired).toBe(0)
  release()
  expect(time.timers.size).toBe(1)
  time.fire()
  expect(expired).toBe(1)
  quiet.dispose()
})

test("disposal removes the deadline", () => {
  const time = clock()
  let expired = 0
  const quiet = new AcpQuiet(time, 10, () => { expired++ })
  quiet.dispose()
  time.fire()
  expect(expired).toBe(0)
})
