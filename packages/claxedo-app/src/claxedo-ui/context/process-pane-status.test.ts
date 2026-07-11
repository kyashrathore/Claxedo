import { describe, expect, test } from "bun:test"
import type { Process } from "@/process/process"
import { createProcessPaneSync, deriveProcessPaneStatus, isStaleProcessSnapshot } from "./process-pane-status"

type ManagedProcess = Process.ManagedProcess

const proc = (status: Process.Status): ManagedProcess =>
  ({ configId: `c-${status}`, status, restartCount: 0 } as ManagedProcess)

describe("deriveProcessPaneStatus", () => {
  test("reports running for running/starting/restarting entries", () => {
    expect(deriveProcessPaneStatus({ a: proc("running") })).toEqual({ running: true, crashed: false })
    expect(deriveProcessPaneStatus({ a: proc("starting") }).running).toBe(true)
    expect(deriveProcessPaneStatus({ a: proc("restarting") }).running).toBe(true)
  })

  test("reports crashed when any entry has crashed status", () => {
    expect(deriveProcessPaneStatus({ a: proc("stopped"), b: proc("crashed") })).toEqual({
      running: false,
      crashed: true,
    })
  })

  test("idle/stopped-only map is neither running nor crashed", () => {
    expect(deriveProcessPaneStatus({ a: proc("idle"), b: proc("stopped") })).toEqual({
      running: false,
      crashed: false,
    })
  })

  test("empty and undefined-hole maps are inert", () => {
    expect(deriveProcessPaneStatus({})).toEqual({ running: false, crashed: false })
    expect(deriveProcessPaneStatus({ a: undefined })).toEqual({ running: false, crashed: false })
  })
})

describe("createProcessPaneSync", () => {
  function harness(input: { processes: Record<string, ManagedProcess>; isProcessOpen: boolean }) {
    const calls = {
      running: [] as Array<[string | null | undefined, boolean]>,
      crashed: [] as Array<[string | null | undefined, boolean]>,
      crashedWhileClosed: [] as boolean[],
    }
    const sync = createProcessPaneSync({
      processes: () => input.processes,
      directory: () => "/repo",
      isProcessOpen: () => input.isProcessOpen,
      setRunning: (dir, v) => calls.running.push([dir, v]),
      setCrashed: (dir, v) => calls.crashed.push([dir, v]),
      setCrashedWhileClosed: (v) => calls.crashedWhileClosed.push(v),
    })
    return { sync, calls }
  }

  test("a crash discovered while the pane is CLOSED raises the persisted attention badge (behavior 10)", () => {
    const { sync, calls } = harness({ processes: { a: proc("crashed") }, isProcessOpen: false })
    sync()
    expect(calls.crashed).toEqual([["/repo", true]])
    // The GET-reconcile path now mirrors the SSE handler and lights the badge.
    expect(calls.crashedWhileClosed).toEqual([true])
  })

  test("a crash discovered while the pane is OPEN flips crashed but does not force the closed badge", () => {
    const { sync, calls } = harness({ processes: { a: proc("crashed") }, isProcessOpen: true })
    sync()
    expect(calls.crashed).toEqual([["/repo", true]])
    expect(calls.crashedWhileClosed).toEqual([]) // open: the badge is not raised
  })

  test("no crash clears both the transient crashed flag and the closed badge", () => {
    const { sync, calls } = harness({ processes: { a: proc("running") }, isProcessOpen: false })
    sync()
    expect(calls.running).toEqual([["/repo", true]])
    expect(calls.crashed).toEqual([["/repo", false]])
    expect(calls.crashedWhileClosed).toEqual([false])
  })
})

// Bug: a managed process that exits immediately (e.g. `exit 1`) left the
// process panel's status heading showing a GREEN ("running") dot even though
// the process had already crashed — the slower `client.start()` HTTP response
// (a "running" snapshot taken at spawn time) resolved after the SSE
// `process.crashed` event and clobbered the store back to "running". These
// pin the guard that rejects that stale same-pty snapshot.

function snap(overrides: Partial<ManagedProcess> & { configId: string }): ManagedProcess {
  return {
    ptyId: undefined,
    status: "idle",
    restartCount: 0,
    exitCode: undefined,
    exitedAt: undefined,
    startedAt: undefined,
    assignedPort: undefined,
    ...overrides,
  } as ManagedProcess
}

describe("isStaleProcessSnapshot", () => {
  test("stale: a 'running' HTTP snapshot arriving after the SAME pty already crashed", () => {
    expect(isStaleProcessSnapshot(
      snap({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 }),
      snap({ configId: "p1", status: "running", ptyId: "pty_1" }),
    )).toBe(true)
  })

  test("stale: a 'starting' HTTP snapshot arriving after the SAME pty already crashed", () => {
    expect(isStaleProcessSnapshot(
      snap({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 }),
      snap({ configId: "p1", status: "starting", ptyId: "pty_1" }),
    )).toBe(true)
  })

  test("not stale: no existing entry yet (first snapshot for this config)", () => {
    expect(isStaleProcessSnapshot(undefined, snap({ configId: "p1", status: "running", ptyId: "pty_1" }))).toBe(false)
  })

  test("not stale: existing process is not in a terminal state", () => {
    expect(isStaleProcessSnapshot(
      snap({ configId: "p1", status: "running", ptyId: "pty_1" }),
      snap({ configId: "p1", status: "running", ptyId: "pty_1" }),
    )).toBe(false)
  })

  test("not stale: crashed but a DIFFERENT ptyId — a legitimate later restart applies normally", () => {
    expect(isStaleProcessSnapshot(
      snap({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 }),
      snap({ configId: "p1", status: "running", ptyId: "pty_2" }),
    )).toBe(false)
  })

  test("not stale: existing crashed with no ptyId recorded", () => {
    expect(isStaleProcessSnapshot(
      snap({ configId: "p1", status: "crashed", ptyId: undefined, exitCode: 1 }),
      snap({ configId: "p1", status: "running", ptyId: "pty_1" }),
    )).toBe(false)
  })

  test("not stale: incoming snapshot has no ptyId", () => {
    expect(isStaleProcessSnapshot(
      snap({ configId: "p1", status: "crashed", ptyId: "pty_1", exitCode: 1 }),
      snap({ configId: "p1", status: "idle", ptyId: undefined }),
    )).toBe(false)
  })
})
