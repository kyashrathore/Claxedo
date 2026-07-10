import { describe, expect, test } from "bun:test"
import { isStaleProcessSnapshot } from "./process-pane"
import type { Process } from "@claxedo/process/process"

type ManagedProcess = Process.ManagedProcess

// Bug B: a managed process that exits immediately (e.g. `exit 1`) left the
// process panel's status heading showing a GREEN ("running") dot even
// though the process had already crashed. Root cause: `client.start()`'s
// HTTP response snapshots the process as "running" the instant the PTY
// spawns, server-side, BEFORE the launched command has necessarily run to
// completion. When the command exits fast enough, the SSE `process.crashed`
// event reaches the browser and correctly flips the store to "crashed"
// BEFORE that slower HTTP response resolves — and the response handler
// (`applyProcess`) then blindly overwrote the store back to "running" with
// the now-stale snapshot. These tests pin the guard that prevents that
// clobber.

function proc(overrides: Partial<ManagedProcess> & { configId: string }): ManagedProcess {
  return {
    ptyId: undefined,
    status: "idle",
    restartCount: 0,
    exitCode: undefined,
    exitedAt: undefined,
    startedAt: undefined,
    assignedPort: undefined,
    ...overrides,
  }
}

describe("isStaleProcessSnapshot", () => {
  test("stale: a 'running' HTTP snapshot arriving after the SAME pty already crashed", () => {
    const existing = proc({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 })
    const incoming = proc({ configId: "p1", status: "running", ptyId: "pty_1" })

    expect(isStaleProcessSnapshot(existing, incoming)).toBe(true)
  })

  test("stale: a 'starting' HTTP snapshot arriving after the SAME pty already crashed", () => {
    const existing = proc({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 })
    const incoming = proc({ configId: "p1", status: "starting", ptyId: "pty_1" })

    expect(isStaleProcessSnapshot(existing, incoming)).toBe(true)
  })

  test("not stale: no existing entry yet (first snapshot for this config)", () => {
    const incoming = proc({ configId: "p1", status: "running", ptyId: "pty_1" })

    expect(isStaleProcessSnapshot(undefined, incoming)).toBe(false)
  })

  test("not stale: existing process is not in a terminal state", () => {
    const existing = proc({ configId: "p1", status: "running", ptyId: "pty_1" })
    const incoming = proc({ configId: "p1", status: "running", ptyId: "pty_1" })

    expect(isStaleProcessSnapshot(existing, incoming)).toBe(false)
  })

  test("not stale: crashed but a DIFFERENT ptyId — a legitimate later restart applies normally", () => {
    const existing = proc({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 })
    const incoming = proc({ configId: "p1", status: "running", ptyId: "pty_2" })

    expect(isStaleProcessSnapshot(existing, incoming)).toBe(false)
  })

  test("not stale: existing crashed with no ptyId recorded", () => {
    const existing = proc({ configId: "p1", status: "crashed", ptyId: undefined, exitCode: 1 })
    const incoming = proc({ configId: "p1", status: "running", ptyId: "pty_1" })

    expect(isStaleProcessSnapshot(existing, incoming)).toBe(false)
  })

  test("not stale: incoming snapshot has no ptyId", () => {
    const existing = proc({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 })
    const incoming = proc({ configId: "p1", status: "idle", ptyId: undefined })

    expect(isStaleProcessSnapshot(existing, incoming)).toBe(false)
  })
})
