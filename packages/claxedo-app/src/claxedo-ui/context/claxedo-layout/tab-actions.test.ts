import { describe, expect, test } from "bun:test"
import { createTabActions } from "./tab-actions"
import type { TabItem, TopTabsState } from "./types"

function createState(items: TabItem[], order: string[]): TopTabsState {
  return {
    items,
    order,
    activeId: items[0]?.id ?? null,
    closedTabs: [],
  }
}

function createActions(state: TopTabsState) {
  return createTabActions(
    () => state.items,
    () => state.activeId,
    () => state.order,
    () => state.closedTabs,
    (fn) => {
      state.items = fn(state.items)
    },
    (id) => {
      state.activeId = id
    },
    (fn) => {
      state.order = fn(state.order)
    },
    (fn) => {
      state.closedTabs = fn(state.closedTabs)
    },
    (fn) => {
      fn(state)
    },
  )
}

describe("tab actions visual order", () => {
  test("process tab groups with its workspace directory", () => {
    const state = createState(
      [
        {
          id: "process",
          type: "process",
          directory: "/ws-a",
          title: "Processes",
          closable: true,
        },
        {
          id: "b-session",
          type: "session",
          directory: "/ws-b",
          title: "B",
          sessionId: "b",
          closable: true,
        },
        {
          id: "a-session",
          type: "session",
          directory: "/ws-a",
          title: "A",
          sessionId: "a",
          closable: true,
        },
      ],
      ["process", "b-session", "a-session"],
    )

    const actions = createActions(state)

    expect(actions.visualOrderedItems().map((tab) => tab.id)).toEqual(["b-session", "process", "a-session"])
  })

  test("addProcess dedupes by directory, not by group", () => {
    const state = createState([], [])
    const actions = createActions(state)

    const main1 = actions.addProcess("/ws-main")
    const main2 = actions.addProcess("/ws-main")
    const feature = actions.addProcess("/ws-feature")

    expect(main2).toBe(main1)
    expect(feature).not.toBe(main1)
    expect(state.items.filter((tab) => tab.type === "process").map((tab) => tab.directory)).toEqual([
      "/ws-main",
      "/ws-feature",
    ])
  })

  test("closing active tab prefers another tab in the same workspace directory", () => {
    const state = createState(
      [
        {
          id: "a-left",
          type: "session",
          directory: "/ws-a",
          title: "A left",
          sessionId: "a-left",
          closable: true,
        },
        {
          id: "b-mid",
          type: "session",
          directory: "/ws-b",
          title: "B mid",
          sessionId: "b-mid",
          closable: true,
        },
        {
          id: "a-active",
          type: "terminal",
          directory: "/ws-a",
          title: "A active",
          terminalId: "pty-a",
          closable: true,
        },
        {
          id: "b-right",
          type: "session",
          directory: "/ws-b",
          title: "B right",
          sessionId: "b-right",
          closable: true,
        },
      ],
      ["a-left", "b-mid", "a-active", "b-right"],
    )
    const actions = createActions(state)
    state.activeId = "a-active"

    actions.close("a-active")

    expect(state.activeId).toBe("a-left")
  })
})
