import { describe, expect, test } from "bun:test"
import { emptyClaxedoState, validate } from "./persistence"
import { MAX_OPEN_SURFACES, SURFACE_IDLE_MS } from "./surface-budget"

const NOW = Date.UTC(2026, 8, 23, 12)
const STALE = NOW - SURFACE_IDLE_MS - 1

const localSessionRef = (sessionId: string) => ({
  sessionId,
  host: "workspace" as const,
  cwd: "/work/foo",
  toolSandbox: { kind: "local" as const, cwd: "/work/foo" },
})

describe("state/persistence", () => {
  test("drops deprecated process contents from persisted workbench state", () => {
    const input = emptyClaxedoState()
    input.workbench = {
      panes: [
        { id: "pane_1", contentId: "process_1" },
        { id: "pane_2", contentId: "session_1" },
      ],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
      contentIds: ["process_1", "session_1"],
      contentRecency: ["process_1", "session_1"],
      focusedPaneId: "pane_1",
      layoutSnapshots: {
        process_1: {
          panes: [{ id: "pane_1", contentId: "process_1" }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
          focusedPaneId: "pane_1",
        },
      },
    }
    input.meta = {
      process_1: {
        id: "process_1",
        type: "process" as never,
        scope: "directory",
        directory: "/work/foo",
      },
      session_1: {
        id: "session_1",
        type: "session",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_1",
        content: {
          type: "session",
          directory: "/work/foo",
          sessionId: "ses_1",
          sessionRef: localSessionRef("ses_1"),
        },
      },
    }

    const result = validate(input)

    expect(result.dirty).toBe(true)
    expect(result.state.workbench.contentIds).toEqual(["session_1"])
    expect(result.state.workbench.contentRecency).toEqual(["session_1"])
    expect(result.state.workbench.panes[0].contentId).toBeNull()
    expect(result.state.workbench.layoutSnapshots.process_1).toBeUndefined()
    expect(result.state.meta.process_1).toBeUndefined()
    expect(result.state.meta.session_1?.type).toBe("session")
  })

  test("preserves a side-by-side session split on validation", () => {
    const input = emptyClaxedoState()
    input.workbench = {
      panes: [
        { id: "pane_1", contentId: "content_1" },
        { id: "pane_2", contentId: "content_2" },
      ],
      split: {
        direction: "h",
        sizes: [0.5, 0.5],
        root: {
          t: "split",
          dir: "h",
          a: { t: "leaf", id: "pane_1" },
          b: { t: "leaf", id: "pane_2" },
          size: 0.5,
        },
      },
      contentIds: ["content_1", "content_2"],
      contentRecency: ["content_1", "content_2"],
      focusedPaneId: "pane_1",
      layoutSnapshots: {},
    }
    input.meta = {
      content_1: {
        id: "content_1",
        type: "session",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_1",
        content: {
          type: "session",
          directory: "/work/foo",
          sessionId: "ses_1",
          sessionRef: localSessionRef("ses_1"),
        },
      },
      content_2: {
        id: "content_2",
        type: "session",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_2",
        content: {
          type: "session",
          directory: "/work/foo",
          sessionId: "ses_2",
          sessionRef: localSessionRef("ses_2"),
        },
      },
    }

    const result = validate(input)

    expect(result.state.workbench.panes).toEqual(input.workbench.panes)
    expect(result.state.workbench.split.root).toEqual(input.workbench.split.root)
    expect(result.state.meta.content_1?.sessionId).toBe("ses_1")
    expect(result.state.meta.content_2?.sessionId).toBe("ses_2")
  })

  test("drops legacy persisted session metadata without explicit SessionRef identity", () => {
    const input = emptyClaxedoState()
    input.workbench = {
      panes: [{ id: "pane_1", contentId: "content_1" }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
      contentIds: ["content_1"],
      contentRecency: ["content_1"],
      focusedPaneId: "pane_1",
      layoutSnapshots: {},
    }
    input.meta = {
      content_1: {
        id: "content_1",
        type: "session",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_1",
        content: { type: "session", directory: "/work/foo", sessionId: "ses_1", title: "Session" },
      },
    }

    const result = validate(input)

    expect(result.dirty).toBe(true)
    expect(result.state.meta.content_1).toBeUndefined()
    expect(result.state.workbench.contentIds).toEqual([])
    expect(result.state.workbench.contentRecency).toEqual([])
    expect(result.state.workbench.panes[0].contentId).toBeNull()
  })

  test("drops legacy persisted context metadata without explicit SessionRef identity", () => {
    const input = emptyClaxedoState()
    input.workbench = {
      panes: [{ id: "pane_1", contentId: "content_1" }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
      contentIds: ["content_1"],
      contentRecency: ["content_1"],
      focusedPaneId: "pane_1",
      layoutSnapshots: {},
    }
    input.meta = {
      content_1: {
        id: "content_1",
        type: "context",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_1",
        content: { type: "context", directory: "/work/foo", sessionId: "ses_1", title: "Context" },
      },
    }

    const result = validate(input)

    expect(result.dirty).toBe(true)
    expect(result.state.meta.content_1).toBeUndefined()
    expect(result.state.workbench.contentIds).toEqual([])
    expect(result.state.workbench.contentRecency).toEqual([])
    expect(result.state.workbench.panes[0].contentId).toBeNull()
  })

  test("drops workbench content without matching metadata", () => {
    const input = emptyClaxedoState()
    input.workbench = {
      panes: [
        { id: "pane_1", contentId: "ghost_content" },
        { id: "pane_2", contentId: "content_1" },
      ],
      split: {
        direction: "h",
        sizes: [0.5, 0.5],
        root: {
          t: "split",
          dir: "h",
          a: { t: "leaf", id: "pane_1" },
          b: { t: "leaf", id: "pane_2" },
          size: 0.5,
        },
      },
      contentIds: ["ghost_content", "content_1"],
      contentRecency: ["ghost_content", "content_1"],
      focusedPaneId: "pane_1",
      layoutSnapshots: {
        ghost_content: {
          panes: [{ id: "pane_1", contentId: "ghost_content" }],
          split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
          focusedPaneId: "pane_1",
        },
      },
    }
    input.meta = {
      content_1: {
        id: "content_1",
        type: "session",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_1",
        content: {
          type: "session",
          directory: "/work/foo",
          sessionId: "ses_1",
          sessionRef: localSessionRef("ses_1"),
        },
      },
    }

    const result = validate(input)

    expect(result.dirty).toBe(true)
    expect(result.state.workbench.contentIds).toEqual(["content_1"])
    expect(result.state.workbench.contentRecency).toEqual(["content_1"])
    expect(result.state.workbench.panes[0].contentId).toBeNull()
    expect(result.state.workbench.layoutSnapshots.ghost_content).toBeUndefined()
    expect(result.state.meta.content_1?.sessionId).toBe("ses_1")
  })

  test("the marketplace does not survive a relaunch", () => {
    const input = emptyClaxedoState()
    input.workbench = {
      panes: [{ id: "pane_1", contentId: "marketplace_1" }],
      split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
      contentIds: ["marketplace_1"],
      contentRecency: ["marketplace_1"],
      focusedPaneId: "pane_1",
      layoutSnapshots: {},
    }
    input.meta = {
      marketplace_1: {
        id: "marketplace_1",
        type: "marketplace",
        scope: "global",
        content: {
          type: "marketplace",
          title: "Marketplace",
        },
      },
    }

    const result = validate(input)

    // A place you go, not work you left open: it is reopened from the rail,
    // never restored as the landing surface.
    expect(result.dirty).toBe(true)
    expect(result.state.meta.marketplace_1).toBeUndefined()
    expect(result.state.workbench.contentIds).toEqual([])
    expect(result.state.workbench.panes[0]?.contentId ?? null).toBeNull()
  })

  test("a persisted blob that still carries a navigator slice loads without it", () => {
    const result = validate({ ...emptyClaxedoState(), navigator: { width: 400, tab: "files" } })

    expect(result.state).not.toHaveProperty("navigator")
    expect(result.dirty).toBe(false)
  })

  describe("surface budget", () => {
    const sessionAt = (index: number) => ({
      id: `content_${index}`,
      type: "session" as const,
      scope: "directory" as const,
      directory: "/work/foo",
      sessionId: `ses_${index}`,
      content: {
        type: "session" as const,
        directory: "/work/foo",
        sessionId: `ses_${index}`,
        sessionRef: localSessionRef(`ses_${index}`),
      },
    })

    /** `count` session surfaces, MRU-first: content_1 newest, content_N oldest. */
    const stateWithSessions = (count: number) => {
      const contentIds = Array.from({ length: count }, (_, i) => `content_${i + 1}`)
      const input = emptyClaxedoState()
      input.workbench = {
        panes: [{ id: "pane_1", contentId: contentIds[0] ?? null }],
        split: { direction: "h", sizes: [1], root: { t: "leaf", id: "pane_1" } },
        contentIds,
        contentRecency: [...contentIds],
        focusedPaneId: "pane_1",
        layoutSnapshots: {},
      }
      input.meta = Object.fromEntries(
        contentIds.map((id, i) => [id, sessionAt(i + 1)]),
      )
      return input
    }

    test("keeps a persisted blob that is already within budget intact", () => {
      const input = stateWithSessions(MAX_OPEN_SURFACES)
      input.activity = Object.fromEntries(input.workbench.contentIds.map((id) => [id, { lastActiveAt: NOW }]))
      const result = validate(input, NOW)

      expect(result.dirty).toBe(false)
      expect(result.state.workbench.contentIds).toHaveLength(MAX_OPEN_SURFACES)
    })

    test("trims an over-budget blob down to the LRU cap", () => {
      // The real-world shape this exists for: a long-lived profile that
      // accumulated every session it ever opened, most of them dead.
      const result = validate(stateWithSessions(151))

      expect(result.dirty).toBe(true)
      expect(result.state.workbench.contentIds).toHaveLength(MAX_OPEN_SURFACES)
      // The cap's worth of most-recent surfaces survive; everything older is gone.
      expect(result.state.workbench.contentIds).toEqual(
        Array.from({ length: MAX_OPEN_SURFACES }, (_, i) => `content_${i + 1}`),
      )
      expect(result.state.workbench.contentIds).not.toContain(`content_${MAX_OPEN_SURFACES + 1}`)
      expect(result.state.workbench.contentRecency).toHaveLength(MAX_OPEN_SURFACES)
    })

    test("drops the meta of every evicted surface", () => {
      const result = validate(stateWithSessions(151))

      expect(Object.keys(result.state.meta)).toHaveLength(MAX_OPEN_SURFACES)
      expect(result.state.meta[`content_${MAX_OPEN_SURFACES + 1}`]).toBeUndefined()
      expect(result.state.meta.content_151).toBeUndefined()
      expect(result.state.meta.content_1?.sessionId).toBe("ses_1")
    })

    test("never evicts a mounted surface, however stale", () => {
      const input = stateWithSessions(151)
      // The oldest surface is the one sitting in the pane.
      input.workbench.panes = [{ id: "pane_1", contentId: "content_151" }]

      const result = validate(input)

      expect(result.state.workbench.contentIds).toContain("content_151")
      expect(result.state.workbench.panes[0]?.contentId).toBe("content_151")
      expect(result.state.workbench.contentIds).toHaveLength(MAX_OPEN_SURFACES)
      expect(result.state.meta.content_151?.sessionId).toBe("ses_151")
    })

    test("never evicts a pinned pages-index surface", () => {
      const input = stateWithSessions(151)
      input.meta.content_151 = {
        id: "content_151",
        type: "pages-index",
        scope: "directory",
        directory: "/work/foo",
      }

      const result = validate(input)

      expect(result.state.workbench.contentIds).toContain("content_151")
      expect(result.state.meta.content_151?.type).toBe("pages-index")
      expect(result.state.workbench.contentIds).toHaveLength(MAX_OPEN_SURFACES)
    })

    describe("idle tabs", () => {
      const withActivity = (activity: ReturnType<typeof emptyClaxedoState>["activity"]) => {
        const input = stateWithSessions(4)
        input.activity = activity
        return input
      }

      test("drops tabs untouched for more than a day and keeps recent ones", () => {
        const result = validate(withActivity({
          content_1: { lastActiveAt: STALE },
          content_2: { lastActiveAt: NOW - 60_000 },
          content_3: { lastActiveAt: STALE },
          content_4: { lastActiveAt: NOW - SURFACE_IDLE_MS },
        }), NOW)

        expect(result.dirty).toBe(true)
        expect(result.state.workbench.contentIds).toEqual(["content_1", "content_2", "content_4"])
        expect(result.state.workbench.contentRecency).not.toContain("content_3")
        expect(result.state.meta.content_3).toBeUndefined()
        expect(result.state.activity.content_3).toBeUndefined()
      })

      test("keeps the tab in a pane however stale it is", () => {
        const result = validate(withActivity({
          content_1: { lastActiveAt: STALE },
          content_2: { lastActiveAt: STALE },
          content_3: { lastActiveAt: NOW },
          content_4: { lastActiveAt: NOW },
        }), NOW)

        expect(result.state.workbench.panes[0]?.contentId).toBe("content_1")
        expect(result.state.workbench.contentIds).toEqual(["content_1", "content_3", "content_4"])
      })

      test("keeps a stale tab whose agent was working or waiting when the app closed", () => {
        const result = validate(withActivity({
          content_1: { lastActiveAt: NOW },
          content_2: { lastActiveAt: STALE, held: true },
          content_3: { lastActiveAt: STALE },
          content_4: { lastActiveAt: NOW },
        }), NOW)

        expect(result.state.workbench.contentIds).toEqual(["content_1", "content_2", "content_4"])
        expect(result.state.activity.content_2).toEqual({ lastActiveAt: STALE, held: true })
      })

      test("keeps a stale pinned pages-index tab", () => {
        const input = withActivity({
          content_1: { lastActiveAt: NOW },
          content_2: { lastActiveAt: STALE },
          content_3: { lastActiveAt: NOW },
          content_4: { lastActiveAt: NOW },
        })
        input.meta.content_2 = { id: "content_2", type: "pages-index", scope: "directory", directory: "/work/foo" }

        const result = validate(input, NOW)

        expect(result.state.workbench.contentIds).toContain("content_2")
      })

      test("stamps a restored tab with no record as active now instead of dropping it", () => {
        const input = withActivity({ content_1: { lastActiveAt: STALE } })
        ;(input as { activity: unknown }).activity = { content_1: { lastActiveAt: STALE }, content_2: { lastActiveAt: "yesterday" } }

        const result = validate(input, NOW)

        expect(result.dirty).toBe(true)
        expect(result.state.workbench.contentIds).toEqual(["content_1", "content_2", "content_3", "content_4"])
        expect(result.state.activity.content_2).toEqual({ lastActiveAt: NOW })
        expect(result.state.activity.content_3).toEqual({ lastActiveAt: NOW })
      })

      test("loads a blob written before activity existed without closing anything", () => {
        const input: Record<string, unknown> = { ...stateWithSessions(4) }
        delete input.activity

        const result = validate(input, NOW)

        expect(result.state.workbench.contentIds).toHaveLength(4)
        expect(Object.values(result.state.activity)).toEqual(Array(4).fill({ lastActiveAt: NOW }))
      })

      test("forgets activity for contents that are no longer open", () => {
        const result = validate(withActivity({
          content_1: { lastActiveAt: NOW },
          content_2: { lastActiveAt: NOW },
          content_3: { lastActiveAt: NOW },
          content_4: { lastActiveAt: NOW },
          closed_long_ago: { lastActiveAt: NOW },
        }), NOW)

        expect(result.dirty).toBe(true)
        expect(result.state.activity.closed_long_ago).toBeUndefined()
      })
    })

    test("spends the budget on live surfaces, not on junk it was going to drop anyway", () => {
      const input = stateWithSessions(MAX_OPEN_SURFACES)
      // Five ids the earlier passes remove: no meta at all. If the budget ran
      // before those drops it would evict five live sessions to make room.
      const junk = ["junk_1", "junk_2", "junk_3", "junk_4", "junk_5"]
      input.workbench.contentIds = [...junk, ...input.workbench.contentIds]
      input.workbench.contentRecency = [...junk, ...input.workbench.contentRecency]

      const result = validate(input)

      expect(result.state.workbench.contentIds).toEqual(
        Array.from({ length: MAX_OPEN_SURFACES }, (_, i) => `content_${i + 1}`),
      )
    })
  })
})
