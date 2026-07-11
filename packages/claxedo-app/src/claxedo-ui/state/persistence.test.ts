import { describe, expect, test } from "bun:test"
import { emptyClaxedoState, validate } from "../persistence"

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

  test("preserves marketplace content on validation", () => {
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

    expect(result.dirty).toBe(false)
    expect(result.state.meta.marketplace_1?.type).toBe("marketplace")
    expect(result.state.meta.marketplace_1?.content?.type).toBe("marketplace")
  })
})
