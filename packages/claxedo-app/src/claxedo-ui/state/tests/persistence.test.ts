import { describe, expect, test } from "bun:test"
import { emptyClaxedoState, validate } from "../persistence"

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
      },
      content_2: {
        id: "content_2",
        type: "session",
        scope: "directory",
        directory: "/work/foo",
        sessionId: "ses_2",
      },
    }

    const result = validate(input)

    expect(result.state.workbench.panes).toEqual(input.workbench.panes)
    expect(result.state.workbench.split.root).toEqual(input.workbench.split.root)
    expect(result.state.meta.content_1?.sessionId).toBe("ses_1")
    expect(result.state.meta.content_2?.sessionId).toBe("ses_2")
  })
})
