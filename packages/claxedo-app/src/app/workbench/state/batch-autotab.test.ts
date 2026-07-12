import { describe, expect, test } from "bun:test"
import {
  createBatchAutoTabListener,
  type BatchAutoTabDeps,
} from "./batch-autotab"

function createHarness(projects: ReturnType<BatchAutoTabDeps["projects"]>) {
  const calls = {
    sessions: [] as Array<{ dir: string; sessionId: string; title: string }>,
    terminals: [] as Array<{ dir: string; terminalId: string; title: string }>,
  }
  let listener: Parameters<BatchAutoTabDeps["listen"]>[0] | undefined
  const cleanup = createBatchAutoTabListener({
    listen(fn) {
      listener = fn
      return () => {}
    },
    adapters: {
      addSession(dir, sessionId, title) {
        calls.sessions.push({ dir, sessionId, title })
        return sessionId
      },
      addTerminal(dir, terminalId, title) {
        calls.terminals.push({ dir, terminalId, title })
        return terminalId
      },
      findSession() {
        return undefined
      },
      findTerminal() {
        return undefined
      },
    },
    projects: () => projects,
  })

  return {
    calls,
    cleanup,
    emit: (event: Parameters<NonNullable<typeof listener>>[0]) => listener?.(event),
  }
}

describe("batch auto-tab listener", () => {
  test("adds sessions created in sandbox directories", () => {
    const harness = createHarness([{ worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }])

    harness.emit({
      name: "/repo/sandbox",
      details: {
        type: "session.created",
        properties: { info: { id: "ses_1", title: "Fix tests" } },
      },
    })

    expect(harness.calls.sessions).toEqual([
      { dir: "/repo/sandbox", sessionId: "ses_1", title: "Fix tests" },
    ])
    harness.cleanup()
  })

  test("does not treat the main worktree as a sandbox", () => {
    const harness = createHarness([{ worktree: "/repo/main", sandboxes: ["/repo/main"] }])

    harness.emit({
      name: "/repo/main",
      details: {
        type: "session.created",
        properties: { info: { id: "ses_1", title: "Main" } },
      },
    })

    expect(harness.calls.sessions).toEqual([])
    harness.cleanup()
  })

  test("uses event info directory when stream name is global", () => {
    const harness = createHarness([{ worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }])

    harness.emit({
      name: "global",
      details: {
        type: "pty.created",
        properties: { info: { id: "pty_1", title: "Codex", directory: "/repo/sandbox" } },
      },
    })

    expect(harness.calls.terminals).toEqual([
      { dir: "/repo/sandbox", terminalId: "pty_1", title: "Codex" },
    ])
    harness.cleanup()
  })
})
