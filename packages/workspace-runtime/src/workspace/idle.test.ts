import { expect, test } from "bun:test"
import { createWorkspaceIdle } from "./idle"

function clock() {
  const state = { busy: false, frozen: false, terminalIoAt: 0, now: 100 }
  const idle = createWorkspaceIdle({ busy: () => state.busy, frozen: () => state.frozen, terminalIoAt: () => state.terminalIoAt, now: () => state.now })
  return { state, idle }
}

test("the idle clock starts when work ends, holds while idle, and a busy read clears it even without an event", () => {
  const { state, idle } = clock()
  expect(idle.since()).toBe(100)
  state.now = 200
  expect(idle.since()).toBe(100)
  state.busy = true
  expect(idle.since()).toBeUndefined()
  state.now = 300
  state.busy = false
  idle.changed()
  state.now = 400
  expect(idle.since()).toBe(300)
})

test("a terminal keeps the workspace awake only by carrying bytes, never by being open", () => {
  const { state, idle } = clock()
  expect(idle.since()).toBe(100)
  state.terminalIoAt = 250
  state.now = 300
  expect(idle.since()).toBe(250)
})

test("a frozen workspace is not idle, and reports since when it has been frozen", () => {
  const { state, idle } = clock()
  state.frozen = true
  expect(idle.since()).toBeUndefined()
  expect(idle.frozenSince()).toBe(100)
  state.now = 900
  expect(idle.frozenSince()).toBe(100)
  state.frozen = false
  expect(idle.frozenSince()).toBeUndefined()
  expect(idle.since()).toBe(900)
})
