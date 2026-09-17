import { describe, expect, test } from "bun:test"
import { createBatchAutoTabListener, type BatchAutoTabDeps } from "./batch-autotab"

function createHarness(projects: ReturnType<BatchAutoTabDeps["projects"]>) {
  const calls = {
    sessions: [] as Array<{ dir: string; sessionId: string; title: string }>,
    terminals: [] as Array<{ dir: string; terminalId: string; title: string }>,
  }
  const handlers = new Map<string, (event: never) => void>()
  const cleanup = createBatchAutoTabListener({
    events: {
      on(type: string, handler: (event: never) => void) {
        handlers.set(type, handler)
        return () => {}
      },
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
    emit: (event: { name: string; details: Record<string, unknown> }) => {
      const directory = event.name === "global" ? undefined : event.name
      handlers.get(String(event.details.type))?.({ ...event.details, ...(directory ? { directory } : {}) } as never)
    },
  }
}

describe("batch auto-tab listener", () => {
  test("adds sessions created in sandbox directories", () => {
    const harness = createHarness([{ worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }])

    harness.emit({
      name: "/repo/sandbox",
      details: { type: "session.lifecycle", phase: "created", sessionID: "ses_1", info: { id: "ses_1", title: "Fix tests" } },
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
      details: { type: "session.lifecycle", phase: "created", sessionID: "ses_1", info: { id: "ses_1", title: "Main" } },
    })

    expect(harness.calls.sessions).toEqual([])
    harness.cleanup()
  })

  test("a pty is filed under its own cwd, whatever the stream stamped on the frame", () => {
    const harness = createHarness([{ worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }])

    harness.emit({
      name: "/repo/main",
      details: { type: "pty.created", info: { id: "pty_2", title: "Codex", cwd: "/repo/sandbox" } },
    })

    expect(harness.calls.terminals).toEqual([
      { dir: "/repo/sandbox", terminalId: "pty_2", title: "Codex" },
    ])
    harness.cleanup()
  })

  test("a pty whose cwd is a main worktree opens no tab", () => {
    const harness = createHarness([{ worktree: "/repo/main", sandboxes: ["/repo/sandbox"] }])

    harness.emit({
      name: "/repo/main",
      details: { type: "pty.created", info: { id: "pty_3", title: "Shell", cwd: "/repo/main" } },
    })

    expect(harness.calls.terminals).toEqual([])
    harness.cleanup()
  })
})
