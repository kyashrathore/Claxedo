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

    // visualOrderedItems groups by directory: unpinned tabs establish group order.
    // Order is ["process", "b-session", "a-session"].
    // Process tab (dir=/ws-a, unpinned) establishes /ws-a group first,
    // then b-session (dir=/ws-b) establishes /ws-b group.
    // Final: /ws-a group [process, a-session], then /ws-b group [b-session].
    expect(actions.visualOrderedItems().map((tab) => tab.id)).toEqual(["process", "a-session", "b-session"])
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

  test("closing a tab preserves surviving tab object identity", () => {
    const left = {
      id: "left",
      type: "session",
      directory: "/ws-a",
      title: "Left",
      sessionId: "left",
      closable: true,
    } satisfies TabItem
    const middle = {
      id: "middle",
      type: "process",
      directory: "/ws-a",
      title: "Processes",
      closable: true,
    } satisfies TabItem
    const right = {
      id: "right",
      type: "terminal",
      directory: "/ws-a",
      title: "Right",
      terminalId: "pty-right",
      closable: true,
    } satisfies TabItem
    const state = createState([left, middle, right], ["left", "middle", "right"])
    const actions = createActions(state)

    actions.close("middle")

    expect(state.items).toEqual([left, right])
    expect(state.items[0]).toBe(left)
    expect(state.items[1]).toBe(right)
  })
})
