import { describe, expect, test } from "bun:test"
import type { PaneLayout } from "./types"
import { paneMentionSystem, paneRefSystem, parsePaneMentions, withPaneIntentName } from "./pane-intent"

const sample = (): PaneLayout => ({
  id: "layout-1",
  name: "default",
  pane: {
    t: "split",
    dir: "v",
    a: { t: "leaf", id: "leaf-doc" },
    b: { t: "leaf", id: "leaf-chat" },
    size: 0.62,
  },
  focus: "leaf-doc",
  contents: {
    "leaf-doc": {
      type: "page",
      directory: "/repo",
      pageId: "page-1",
      intent: {
        name: "doc",
        role: "document",
        meta: {
          page_id: "page-1",
        },
      },
    },
    "leaf-chat": {
      type: "session",
      directory: "/repo",
      sessionId: "new",
      intent: {
        name: "chat",
        refs: ["doc"],
      },
    },
  },
})

describe("pane intent", () => {
  test("adds a default name when missing", () => {
    const next = withPaneIntentName({ type: "session", directory: "/repo", sessionId: "new" }, "leaf-a")
    expect(next.intent?.name).toBe("session-a")
  })

  test("builds ref system text from refs", () => {
    const text = paneRefSystem(sample(), "leaf-chat")
    expect(text).toContain("Pane refs:")
    expect(text).toContain("#doc")
    expect(text).toContain("page_id")
  })

  test("extracts pane mentions and deduplicates", () => {
    const mentions = parsePaneMentions("check #doc and #Doc and #chat")
    expect(mentions).toEqual(["doc", "chat"])
  })

  test("builds mention system text from matching panes", () => {
    const text = paneMentionSystem(sample(), "Please use #doc")
    expect(text).toContain("Pane mentions")
    expect(text).toContain("#doc")
    expect(text).toContain("page_id")
  })
})
