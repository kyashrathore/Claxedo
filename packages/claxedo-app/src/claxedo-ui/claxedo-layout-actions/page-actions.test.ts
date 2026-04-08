import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let createPageActions: typeof import("./page-actions").createPageActions

beforeAll(async () => {
  const mod = await import("./page-actions")
  createPageActions = mod.createPageActions
})

function makeProps(focusedId = "g1") {
  const addIndexCalls: Array<{ directory?: string }> = []
  const setFocusCalls: string[] = []
  const dispatchCalls: Array<{ type: string; [key: string]: unknown }> = []
  const topTabsAddIndexCalls: Array<{ directory?: string }> = []
  const navigateCalls: string[] = []

  const props = {
    navigate: (path: string) => navigateCalls.push(path),
    activeWorkspaceId: () => "/workspace/main",
    projects: () => [{ worktree: "/workspace/main" }],
    params: {},
    globalSDK: {
      client: {
        session: {
          create: async () => ({ data: { id: "ses-page-1" } }),
        },
      },
    },
    claxedo: {
      dispatch: (command: { type: string; [key: string]: unknown }) => {
        dispatchCalls.push(command)
        if (command.type === "SplitFocusRequested" && typeof command.groupId === "string") {
          setFocusCalls.push(command.groupId)
        }
      },
      split: {
        focusedId: () => focusedId,
      },
      groupTabs: (gid: string) => ({
        addPagesIndex: (directory?: string) => {
          addIndexCalls.push({ directory })
          return "tab-pages"
        },
      }),
      topTabs: {
        addPagesIndex: (directory?: string) => {
          topTabsAddIndexCalls.push({ directory })
          return "tab-pages"
        },
      },
    },
  } as any

  return { props, addIndexCalls, setFocusCalls, dispatchCalls, topTabsAddIndexCalls, navigateCalls }
}

describe("createPageActions", () => {
  test("handleNewPage() without groupId uses focusedId group", () => {
    const { props, addIndexCalls, topTabsAddIndexCalls, navigateCalls } = makeProps("g1")
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(addIndexCalls.length).toBe(1)
    expect(topTabsAddIndexCalls.length).toBe(0)
    expect(navigateCalls).toEqual([`/${base64Encode("/workspace/main")}/tab/tab-pages`])
  })

  test("handleNewPage(groupId) uses specified group via groupTabs(groupId)", () => {
    const { props, addIndexCalls, topTabsAddIndexCalls } = makeProps("g1")
    const actions = createPageActions(props)
    actions.handleNewPage("g2")
    expect(addIndexCalls.length).toBe(1)
    expect(topTabsAddIndexCalls.length).toBe(0)
  })

  test("handleNewPage() calls tabs.addPagesIndex()", () => {
    const { props, addIndexCalls } = makeProps("g1")
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(addIndexCalls).toEqual([{ directory: undefined }])
  })

  test("handleNewPage() dispatches split focus command for target group", () => {
    const { props, setFocusCalls, dispatchCalls } = makeProps("g1")
    const actions = createPageActions(props)

    actions.handleNewPage()
    expect(setFocusCalls).toEqual(["g1"])
    expect(dispatchCalls[0]).toMatchObject({ type: "SplitFocusRequested", groupId: "g1" })

    actions.handleNewPage("g5")
    expect(setFocusCalls).toEqual(["g1", "g5"])
    expect(dispatchCalls[1]).toMatchObject({ type: "SplitFocusRequested", groupId: "g5" })
  })
})
