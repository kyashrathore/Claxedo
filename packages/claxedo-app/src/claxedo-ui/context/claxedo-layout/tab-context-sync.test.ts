import { describe, expect, test } from "bun:test"
import type { PaneLayout, TabItem } from "./types"
import { buildTabContextSnapshot, createTabContextSyncAdapter, type TabContextSnapshot } from "./tab-context-sync"

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("tab context sync", () => {
  test("buildTabContextSnapshot maps pane metadata and terminal ids", () => {
    const tab: TabItem = {
      id: "tab-1",
      type: "review-workspace",
      directory: "/ws",
      sessionId: "s-1",
      terminalId: "pty-a",
      title: "Session 1",
      reviewMode: "uncommitted",
      reviewFromRef: "main",
      reviewToRef: "HEAD",
      closable: true,
    }

    const layout: PaneLayout = {
      id: "layout-1",
      name: "default",
      pane: {
        t: "split",
        dir: "v",
        a: { t: "leaf", id: "leaf-left" },
        b: { t: "leaf", id: "leaf-right" },
        size: 0.6,
      },
      focus: "leaf-right",
      contents: {
        "leaf-left": {
          type: "terminal",
          directory: "/ws",
          terminalId: "pty-a",
          title: "Terminal",
        },
        "leaf-right": {
          type: "session",
          directory: "/ws",
          sessionId: "s-1",
          terminalId: "pty-b",
          title: "Session",
        },
      },
    }

    const snapshot = buildTabContextSnapshot({ groupId: "g-1", tab, layout })

    expect(snapshot.groupId).toBe("g-1")
    expect(snapshot.tabId).toBe("tab-1")
    expect(snapshot.tabType).toBe("review-workspace")
    expect(snapshot.reviewMode).toBe("uncommitted")
    expect(snapshot.reviewFromRef).toBe("main")
    expect(snapshot.reviewToRef).toBe("HEAD")
    expect(snapshot.activeLeafId).toBe("leaf-right")
    expect(snapshot.focusedLeafId).toBe("leaf-right")
    expect(snapshot.panes).toHaveLength(2)
    expect(snapshot.terminalIds).toEqual(["pty-a", "pty-b"])
  })

  test("createTabContextSyncAdapter dedupes unchanged snapshots", async () => {
    const calls: Array<{ url: string; body: string }> = []
    const request: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        body: String(init?.body ?? ""),
      })
      return new Response("ok", { status: 200 })
    }

    const adapter = createTabContextSyncAdapter({
      sdkUrl: () => "https://example.com",
      request,
    })

    const snapshot: TabContextSnapshot = {
      tabId: "tab-1",
      groupId: "g-1",
      tabType: "session",
      directory: "/ws",
      title: "Session",
      sessionId: "s-1",
      reviewMode: undefined,
      reviewFromRef: undefined,
      reviewToRef: undefined,
      pageId: undefined,
      terminalId: undefined,
      activeLeafId: "leaf-a",
      focusedLeafId: "leaf-a",
      terminalIds: [] as string[],
      panes: [],
      updatedAt: 1,
    }

    adapter.push(snapshot)
    adapter.push({
      ...snapshot,
      updatedAt: 2,
    })
    adapter.push({
      ...snapshot,
      title: "Renamed",
      updatedAt: 3,
    })

    await waitTick()

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("https://example.com/hook/tab-context")
    expect(calls[1]?.url).toBe("https://example.com/hook/tab-context")
  })
})
