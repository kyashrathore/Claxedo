import { expect, test } from "bun:test"
import { createWorkspaceIdle } from "./idle"

test("the idle clock starts when work ends, holds while idle, and a busy read clears it even without an event", () => {
  let busy = false
  let now = 100
  const idle = createWorkspaceIdle(() => busy, () => now)
  expect(idle.since()).toBe(100)
  now = 200
  expect(idle.since()).toBe(100)
  busy = true
  expect(idle.since()).toBeUndefined()
  now = 300
  busy = false
  idle.changed()
  now = 400
  expect(idle.since()).toBe(300)
})
