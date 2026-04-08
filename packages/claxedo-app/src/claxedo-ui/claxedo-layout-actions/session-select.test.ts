/**
 * Session Select → Tab Creation Tests
 *
 * Tests the exact logic from handleSessionSelect (session-actions.tsx:15-49)
 * using a REAL claxedo layout store. We replicate the handler code inline to
 * avoid transitive UI imports that fail in test env.
 *
 * handleSessionSelect does:
 *   1. Find session in per-workspace store (for title/summary)
 *   2. topTabs.addSession(workspaceDir, sessionId, title, badge)
 *   3. topTabs.setActive(id)
 *   4. nav(`/${base64Encode(workspaceDir)}/session/${sessionId}`)
 *
 * This test verifies that for ANY session index (1st, 5th, 6th, 10th),
 * steps 2-4 produce a real tab in the store and trigger navigation.
 */
import { beforeAll, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ensureLayoutMocked, getInitLayout } from "../context/_test-helper"
import { sessionRoute } from "../context/claxedo-layout/tab-route"

let initLayout: () => any

beforeAll(async () => {
  await ensureLayoutMocked()
  initLayout = getInitLayout()
})

function createTestLayout() {
  let dispose!: () => void
  const api = createRoot((d) => {
    dispose = d
    return initLayout()
  })
  return { api, dispose }
}

/**
 * Replicate the exact handleSessionSelect logic from session-actions.tsx:15-49.
 * This avoids importing the real module (which has transitive UI deps).
 *
 * DRIFT RISK: If session-actions.tsx changes its resolution, tab-creation,
 * logic, this mirror must be updated in lockstep. Grep for
 * "simulateHandleSessionSelect" if the handler changes.
 */
function simulateHandleSessionSelect(
  api: any,
  nav: (path: string) => void,
  workspaceDir: string,
  sessionId: string,
  opts?: {
    /** Per-workspace session store — may have the session or not. */
    perWorkspaceSessions?: Array<{ id: string; directory: string; title?: string; summary?: any }>
  },
) {
  // Find session in per-workspace store
  const session = (opts?.perWorkspaceSessions ?? []).find(
    (s) => s.id === sessionId && s.directory === workspaceDir,
  )
  const title = session?.title || "Session"
  const summary = session?.summary

  // Match handleSessionSelect's group-targeting logic:
  // Find the group matching the workspace, fall back to focused group
  const groups = api.split.groups()
  const focusedId = api.split.focusedId()
  const matches = groups.filter((g: any) => api.groupWorktree(g.id).default() === workspaceDir)
  const targetGroupId = matches.find((g: any) => g.id === focusedId)?.id ?? matches[0]?.id ?? focusedId
  const tabs = targetGroupId ? api.groupTabs(targetGroupId) : api.topTabs

  const id = tabs.addSession(
    workspaceDir,
    sessionId,
    title,
    summary ? { additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 } : undefined,
  )

  // setActive + nav
  if (id) {
    tabs.setActive(id)
    nav(sessionRoute(workspaceDir, sessionId))
  }

  return id
}

// ---------------------------------------------------------------------------
// Core: clicking a session creates a tab
// ---------------------------------------------------------------------------

describe("handleSessionSelect creates a tab for clicked session", () => {
  test("clicking 1st session creates a tab and navigates", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const navCalls: string[] = []

      simulateHandleSessionSelect(api, (p) => navCalls.push(p), "/ws/main", "session-1")

      const items = api.groupTabs(g1).items()
      expect(items).toHaveLength(1)
      expect(items[0].sessionId).toBe("session-1")
      expect(items[0].type).toBe("session")
      expect(items[0].directory).toBe("/ws/main")

      const active = api.select.groupActiveTab(g1)
      expect(active).toBeDefined()
      expect(active!.sessionId).toBe("session-1")

      expect(navCalls).toHaveLength(1)
      expect(navCalls[0]).toBe(sessionRoute("/ws/main", "session-1"))
    } finally {
      dispose()
    }
  })

  test("clicking 6th session creates a SEPARATE tab — not reusing 1st", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const navCalls: string[] = []

      // Click sessions 1-5
      for (let i = 1; i <= 5; i++) {
        simulateHandleSessionSelect(api, (p) => navCalls.push(p), "/ws/main", `s${i}`)
      }
      expect(api.groupTabs(g1).items()).toHaveLength(5)
      const firstTabIds = api.groupTabs(g1).items().map((t: any) => t.id)
      navCalls.length = 0

      // Click session 6
      const tabId = simulateHandleSessionSelect(api, (p) => navCalls.push(p), "/ws/main", "s6")

      // Must have 6 tabs
      expect(api.groupTabs(g1).items()).toHaveLength(6)

      // Session 6 must be active
      const active = api.select.groupActiveTab(g1)
      expect(active!.sessionId).toBe("s6")

      // Tab ID must be new (not reusing any of the first 5)
      expect(firstTabIds).not.toContain(tabId)

      // Navigation happened
      expect(navCalls).toHaveLength(1)
      expect(navCalls[0]).toBe(sessionRoute("/ws/main", "s6"))
    } finally {
      dispose()
    }
  })

  test("clicking 10th session works identically to 1st", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const navCalls: string[] = []

      for (let i = 1; i <= 9; i++) {
        simulateHandleSessionSelect(api, () => {}, "/ws/main", `s${i}`)
      }
      expect(api.groupTabs(g1).items()).toHaveLength(9)

      simulateHandleSessionSelect(api, (p) => navCalls.push(p), "/ws/main", "s10")

      expect(api.groupTabs(g1).items()).toHaveLength(10)
      expect(api.select.groupActiveTab(g1)!.sessionId).toBe("s10")
      expect(navCalls).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  test("duplicate click reuses existing tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id

      simulateHandleSessionSelect(api, () => {}, "/ws/main", "s1")
      const firstId = api.select.groupActiveTab(g1)!.id

      simulateHandleSessionSelect(api, () => {}, "/ws/main", "s1")

      expect(api.groupTabs(g1).items()).toHaveLength(1)
      expect(api.select.groupActiveTab(g1)!.id).toBe(firstId)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Stale sessions (not in per-workspace store)
// ---------------------------------------------------------------------------

describe("stale sessions (not in per-workspace store)", () => {
  test("session not found in per-workspace store still creates tab", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const navCalls: string[] = []

      // No per-workspace sessions — simulates a stale/not-yet-synced session
      simulateHandleSessionSelect(api, (p) => navCalls.push(p), "/ws/main", "stale-123", {
        perWorkspaceSessions: [],
      })

      expect(api.groupTabs(g1).items()).toHaveLength(1)
      expect(api.groupTabs(g1).items()[0].sessionId).toBe("stale-123")
      expect(api.groupTabs(g1).items()[0].title).toBe("Session") // fallback title
      expect(navCalls).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  test("session found in per-workspace store gets correct title", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id

      simulateHandleSessionSelect(api, () => {}, "/ws/main", "s1", {
        perWorkspaceSessions: [
          { id: "s1", directory: "/ws/main", title: "My Custom Title" },
        ],
      })

      expect(api.groupTabs(g1).items()[0].title).toBe("My Custom Title")
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Empty dir edge case
// ---------------------------------------------------------------------------

describe("empty workspaceDir", () => {
  test("empty string dir returns early — no tab created", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const navCalls: string[] = []

      simulateHandleSessionSelect(api, (p) => navCalls.push(p), "", "s1")

      expect(api.groupTabs(g1).items()).toHaveLength(0)
      expect(navCalls).toHaveLength(0)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle: select, close all, re-select
// ---------------------------------------------------------------------------

describe("close all tabs then select from sidebar", () => {
  test("selecting after empty state works", () => {
    const { api, dispose } = createTestLayout()
    try {
      const g1 = api.split.groups()[0].id
      const navCalls: string[] = []

      // Open and close
      simulateHandleSessionSelect(api, () => {}, "/ws/main", "old")
      const oldId = api.groupTabs(g1).items()[0].id
      api.groupTabs(g1).close(oldId)
      expect(api.groupTabs(g1).items()).toHaveLength(0)

      // Select new session
      simulateHandleSessionSelect(api, (p) => navCalls.push(p), "/ws/main", "fresh")

      expect(api.groupTabs(g1).items()).toHaveLength(1)
      expect(api.select.groupActiveTab(g1)!.sessionId).toBe("fresh")
      expect(navCalls).toHaveLength(1)
    } finally {
      dispose()
    }
  })
})
