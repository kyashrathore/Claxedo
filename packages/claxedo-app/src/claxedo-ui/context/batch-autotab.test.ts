/**
 * Batch Auto-Tab Listener Tests
 *
 * Tests that session.created and pty.created events from sandbox directories
 * automatically add tabs to the layout without stealing focus.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "./_test-helper"

// ---------------------------------------------------------------------------
// Mock emitter (same pattern as listener.test.ts)
// ---------------------------------------------------------------------------

type Listener = (event: any) => void

function createMockEmitter() {
  const listenFns = new Set<Listener>()

  return {
    listen(fn: Listener) {
      listenFns.add(fn)
      return () => {
        listenFns.delete(fn)
      }
    },
    emitListen(directory: string, details: any) {
      for (const fn of listenFns) fn({ name: directory, details })
    },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let initLayout: () => any

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()
})

let mockEmitter: ReturnType<typeof createMockEmitter>

beforeEach(() => {
  mockEmitter = createMockEmitter()
})

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

import { createBatchAutoTabListener } from "./batch-autotab"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAIN_DIR = "/projects/my-app"
const SANDBOX_DIR = "/projects/my-app/.opencode/worktree/proj/clever-circuit"
const SANDBOX_DIR_2 = "/projects/my-app/.opencode/worktree/proj/quick-fox"
const UNKNOWN_DIR = "/other/project"

function createTestHarness(
  projects: Array<{ worktree: string; sandboxes?: string[] }> = [
    { worktree: MAIN_DIR, sandboxes: [SANDBOX_DIR, SANDBOX_DIR_2] },
  ],
) {
  let dispose!: () => void
  let api: any

  createRoot((d) => {
    dispose = d
    api = initLayout()

    createBatchAutoTabListener({
      listen: mockEmitter.listen,
      topTabs: api.topTabs,
      projects: () => projects,
    })
  })

  return { api: api!, dispose }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("batch auto-tab listener", () => {
  // -------------------------------------------------------------------------
  // session.created from sandbox directory
  // -------------------------------------------------------------------------
  describe("session.created from sandbox directory", () => {
    test("adds session tab when event fires for sandbox dir", () => {
      const { api, dispose } = createTestHarness()
      try {
        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "session.created",
          properties: { info: { id: "session_123", title: "Fix bug", directory: SANDBOX_DIR } },
        })

        const tabs = api.topTabs.items()
        const sessionTab = tabs.find((t: any) => t.type === "session" && t.sessionId === "session_123")
        expect(sessionTab).toBeDefined()
        expect(sessionTab.directory).toBe(SANDBOX_DIR)
      } finally {
        dispose()
      }
    })

    test("does NOT add tab for main project directory", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen(MAIN_DIR, {
          type: "session.created",
          properties: { info: { id: "session_456", title: "Main session", directory: MAIN_DIR } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("does NOT add tab for unknown directory (not sandbox)", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen(UNKNOWN_DIR, {
          type: "session.created",
          properties: { info: { id: "session_789", title: "Unknown", directory: UNKNOWN_DIR } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("does NOT add duplicate tab for same session", () => {
      const { api, dispose } = createTestHarness()
      try {
        const event = {
          type: "session.created",
          properties: { info: { id: "session_dup", title: "Duplicate", directory: SANDBOX_DIR } },
        }

        mockEmitter.emitListen(SANDBOX_DIR, event)
        mockEmitter.emitListen(SANDBOX_DIR, event)

        const sessionTabs = api.topTabs.items().filter((t: any) => t.sessionId === "session_dup")
        expect(sessionTabs).toHaveLength(1)
      } finally {
        dispose()
      }
    })

    test("does NOT steal focus (active tab unchanged)", () => {
      const { api, dispose } = createTestHarness()
      try {
        // Add an initial tab and make it active
        const existingId = api.topTabs.addSession(MAIN_DIR, "existing_session", "Existing")
        api.topTabs.setActive(existingId)
        const activeBefore = api.topTabs.activeId()

        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "session.created",
          properties: { info: { id: "session_bg", title: "Background", directory: SANDBOX_DIR } },
        })

        expect(api.topTabs.activeId()).toBe(activeBefore)
      } finally {
        dispose()
      }
    })

    test("uses session title from event properties", () => {
      const { api, dispose } = createTestHarness()
      try {
        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "session.created",
          properties: { info: { id: "session_titled", title: "My Custom Title", directory: SANDBOX_DIR } },
        })

        const tab = api.topTabs.items().find((t: any) => t.sessionId === "session_titled")
        expect(tab).toBeDefined()
        expect(tab.title).toBe("My Custom Title")
      } finally {
        dispose()
      }
    })
  })

  // -------------------------------------------------------------------------
  // pty.created from sandbox directory
  // -------------------------------------------------------------------------
  describe("pty.created from sandbox directory", () => {
    test("adds terminal tab when event fires for sandbox dir", () => {
      const { api, dispose } = createTestHarness()
      try {
        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "pty.created",
          properties: { info: { id: "pty_abc", title: "claude: Fix bug", cwd: SANDBOX_DIR } },
        })

        const tabs = api.topTabs.items()
        const terminalTab = tabs.find((t: any) => t.type === "terminal" && t.terminalId === "pty_abc")
        expect(terminalTab).toBeDefined()
        expect(terminalTab.directory).toBe(SANDBOX_DIR)
      } finally {
        dispose()
      }
    })

    test("does NOT add tab for main project directory", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen(MAIN_DIR, {
          type: "pty.created",
          properties: { info: { id: "pty_main", title: "Terminal", cwd: MAIN_DIR } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("does NOT add duplicate tab for same PTY", () => {
      const { api, dispose } = createTestHarness()
      try {
        const event = {
          type: "pty.created",
          properties: { info: { id: "pty_dup", title: "Terminal", cwd: SANDBOX_DIR } },
        }

        mockEmitter.emitListen(SANDBOX_DIR, event)
        mockEmitter.emitListen(SANDBOX_DIR, event)

        const terminalTabs = api.topTabs.items().filter((t: any) => t.terminalId === "pty_dup")
        expect(terminalTabs).toHaveLength(1)
      } finally {
        dispose()
      }
    })

    test("uses PTY title from event properties", () => {
      const { api, dispose } = createTestHarness()
      try {
        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "pty.created",
          properties: { info: { id: "pty_titled", title: "claude: Fix login", cwd: SANDBOX_DIR } },
        })

        const tab = api.topTabs.items().find((t: any) => t.terminalId === "pty_titled")
        expect(tab).toBeDefined()
        expect(tab.title).toBe("claude: Fix login")
      } finally {
        dispose()
      }
    })
  })

  // -------------------------------------------------------------------------
  // ignores non-sandbox events
  // -------------------------------------------------------------------------
  describe("ignores non-sandbox events", () => {
    test('ignores global events (directory === "global")', () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen("global", {
          type: "session.created",
          properties: { info: { id: "session_g", title: "Global" } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("ignores events with no directory", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen("", {
          type: "session.created",
          properties: { info: { id: "session_empty", title: "No dir" } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("ignores session.created for main project dir", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen(MAIN_DIR, {
          type: "session.created",
          properties: { info: { id: "session_main", title: "Main", directory: MAIN_DIR } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("ignores pty.created for main project dir", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen(MAIN_DIR, {
          type: "pty.created",
          properties: { info: { id: "pty_main2", title: "Term", cwd: MAIN_DIR } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })

    test("ignores unrelated event types (message.updated, etc.)", () => {
      const { api, dispose } = createTestHarness()
      try {
        const tabsBefore = api.topTabs.items().length

        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "message.updated",
          properties: { messageID: "msg_1" },
        })
        mockEmitter.emitListen(SANDBOX_DIR, {
          type: "session.status",
          properties: { sessionID: "session_x", status: { type: "busy" } },
        })

        expect(api.topTabs.items().length).toBe(tabsBefore)
      } finally {
        dispose()
      }
    })
  })
})
