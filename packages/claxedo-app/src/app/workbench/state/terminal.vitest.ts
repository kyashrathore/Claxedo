// Terminal slice behavior spec (vitest — needs fake timers + a reactive owner
// for the initial-reservation timer and its onCleanup).
//
// Covers the two pieces of nontrivial stateful logic the audit flagged as
// untested: the lifecycle transition table and the process-pty pending-start
// counter (including the bare 15s reservation timer and its cleanup).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createTerminalSlice, type TerminalSliceApi } from "./terminal"
import { emptyClaxedoState } from "./persistence"
import type { ClaxedoState, TerminalLifecycleState } from "./types"

function mountSlice() {
  let dispose = () => {}
  let terminal!: TerminalSliceApi
  createRoot((d) => {
    dispose = d
    const [state, setState] = createStore<ClaxedoState>(emptyClaxedoState())
    terminal = createTerminalSlice({ state, setState })
  })
  return { terminal, dispose }
}

describe("terminal slice — lifecycle transition table", () => {
  afterEach(() => vi.useRealTimers())

  test("undefined start accepts any live state and rejects nothing initially", () => {
    const { terminal, dispose } = mountSlice()
    expect(terminal.transitionLifecycle("t1", "attaching")).toBe(true)
    expect(terminal.lifecycle("t1")).toBe("attaching")
    dispose()
  })

  test("creating advances forward but a full table of illegal jumps is refused", () => {
    const { terminal, dispose } = mountSlice()
    const legal: Record<TerminalLifecycleState, TerminalLifecycleState[]> = {
      creating: ["attaching", "attached", "closing", "closed"],
      attaching: ["attached", "closing", "closed"],
      attached: ["closing", "closed"],
      closing: ["closed"],
      closed: ["creating", "attaching", "attached"],
    }
    const all: TerminalLifecycleState[] = ["creating", "attaching", "attached", "closing", "closed"]
    let id = 0
    for (const from of all) {
      for (const to of all) {
        if (from === to) continue
        const t = `t-${id++}`
        // Seed `from` directly (undefined start allows any first hop).
        expect(terminal.transitionLifecycle(t, from)).toBe(true)
        const shouldAllow = legal[from].includes(to)
        expect(terminal.transitionLifecycle(t, to)).toBe(shouldAllow)
        expect(terminal.lifecycle(t)).toBe(shouldAllow ? to : from)
      }
    }
    dispose()
  })

  test("re-transition to the current state is a no-op success", () => {
    const { terminal, dispose } = mountSlice()
    terminal.transitionLifecycle("t", "attached")
    expect(terminal.transitionLifecycle("t", "attached")).toBe(true)
    expect(terminal.lifecycle("t")).toBe("attached")
    dispose()
  })
})

describe("terminal slice — process-pty pending-start counter", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("starts at 1 so a process PTY arriving before the pane provider mounts is not auto-tabbed", () => {
    const { terminal, dispose } = mountSlice()
    expect(terminal.pendingProcessStarts()).toBe(1)
    dispose()
  })

  test("collapses the initial reservation to 0 after 15s when nothing bumped it", () => {
    const { terminal, dispose } = mountSlice()
    vi.advanceTimersByTime(15_000)
    expect(terminal.pendingProcessStarts()).toBe(0)
    dispose()
  })

  test("leaves a bumped counter alone after 15s (only the pristine 1 collapses)", () => {
    const { terminal, dispose } = mountSlice()
    terminal.expectProcessPty() // now 2
    vi.advanceTimersByTime(15_000)
    expect(terminal.pendingProcessStarts()).toBe(2)
    dispose()
  })

  test("expect/resolve move the counter and resolve floors at 0", () => {
    const { terminal, dispose } = mountSlice()
    terminal.expectProcessPty() // 2
    terminal.expectProcessPty() // 3
    terminal.resolveProcessPty() // 2
    terminal.resolveInitialProcessPty() // 1
    terminal.resolveProcessPty() // 0
    terminal.resolveProcessPty() // floored at 0
    expect(terminal.pendingProcessStarts()).toBe(0)
    dispose()
  })

  test("disposing the owner clears the 15s reservation timer (no leaked timer)", () => {
    const { dispose } = mountSlice()
    expect(vi.getTimerCount()).toBe(1)
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
