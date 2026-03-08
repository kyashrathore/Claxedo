import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let createPageActions: typeof import("./page-actions").createPageActions

beforeAll(async () => {
  const mod = await import("./page-actions")
  createPageActions = mod.createPageActions
})

function makeProps(focusedId = "g1") {
  const addPageCalls: Array<{ id: string; title: string; directory?: string }> = []
  const setFocusCalls: string[] = []
  const dispatchCalls: Array<{ type: string; [key: string]: unknown }> = []
  const topTabsAddPageCalls: Array<{ id: string; title: string; directory?: string }> = []
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
        addPage: (id: string, title: string, directory?: string) => {
          addPageCalls.push({ id, title, directory })
          return `tab-${id}`
        },
      }),
      topTabs: {
        addPage: (id: string, title: string, directory?: string) => {
          topTabsAddPageCalls.push({ id, title, directory })
          return `tab-${id}`
        },
      },
    },
  } as any

  return { props, addPageCalls, setFocusCalls, dispatchCalls, topTabsAddPageCalls, navigateCalls }
}

describe("createPageActions", () => {
  test("handleNewPage() without groupId uses focusedId group", () => {
    const { props, addPageCalls, topTabsAddPageCalls, navigateCalls } = makeProps("g1")
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(addPageCalls.length).toBe(1)
    expect(topTabsAddPageCalls.length).toBe(0)
    expect(navigateCalls).toEqual([`/${base64Encode("/workspace/main")}/tab/tab-__index__`])
  })

  test("handleNewPage(groupId) uses specified group via groupTabs(groupId)", () => {
    const { props, addPageCalls, topTabsAddPageCalls } = makeProps("g1")
    const actions = createPageActions(props)
    actions.handleNewPage("g2")
    expect(addPageCalls.length).toBe(1)
    expect(topTabsAddPageCalls.length).toBe(0)
  })

  test("handleNewPage() calls tabs.addPage with __index__ sentinel and Pages title", () => {
    const { props, addPageCalls } = makeProps("g1")
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(addPageCalls.length).toBe(1)
    const first = addPageCalls[0]
    expect(first?.id).toBe("__index__")
    expect(first?.title).toBe("Pages")
    expect(first?.directory).toBe("/workspace/main")
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
