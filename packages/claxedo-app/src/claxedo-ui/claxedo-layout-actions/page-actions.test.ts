import { beforeAll, beforeEach, describe, expect, test, mock } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let createPageActions: typeof import("./page-actions").createPageActions
let createCallCount: number

beforeAll(async () => {
  createCallCount = 0
  mock.module("../../utils/pages-api", () => ({
    pagesApi: {
      create: async (title: string) => {
        createCallCount++
        return {
          id: `page-mock-${createCallCount}`,
          title,
          content: "",
          created_at: "",
          updated_at: "",
        }
      },
    },
  }))
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
  beforeEach(() => {
    createCallCount = 0
  })

  test("handleNewPage() without groupId uses focusedId group", async () => {
    const { props, addPageCalls, topTabsAddPageCalls, navigateCalls } = makeProps("g1")
    const actions = createPageActions(props)
    await actions.handleNewPage()
    expect(addPageCalls.length).toBe(1)
    expect(topTabsAddPageCalls.length).toBe(0)
    expect(navigateCalls).toEqual([`/${base64Encode("/workspace/main")}/tab/tab-page-mock-1`])
  })

  test("handleNewPage(groupId) uses specified group via groupTabs(groupId)", async () => {
    const { props, addPageCalls, topTabsAddPageCalls } = makeProps("g1")
    const actions = createPageActions(props)
    await actions.handleNewPage("g2")
    expect(addPageCalls.length).toBe(1)
    expect(topTabsAddPageCalls.length).toBe(0)
  })

  test("handleNewPage() calls tabs.addPage with API response id and title", async () => {
    const { props, addPageCalls } = makeProps("g1")
    const actions = createPageActions(props)
    await actions.handleNewPage()
    expect(addPageCalls.length).toBe(1)
    const first = addPageCalls[0]
    expect(first?.id).toBe("page-mock-1")
    expect(first?.title).toBe("Untitled")
    expect(first?.directory).toBe("/workspace/main")
  })

  test("handleNewPage() dispatches split focus command for target group", async () => {
    const { props, setFocusCalls, dispatchCalls } = makeProps("g1")
    const actions = createPageActions(props)

    await actions.handleNewPage()
    expect(setFocusCalls).toEqual(["g1"])
    expect(dispatchCalls[0]).toMatchObject({ type: "SplitFocusRequested", groupId: "g1" })

    await actions.handleNewPage("g5")
    expect(setFocusCalls).toEqual(["g1", "g5"])
    expect(dispatchCalls[1]).toMatchObject({ type: "SplitFocusRequested", groupId: "g5" })
  })

  test("catches API errors without throwing", async () => {
    mock.module("../../utils/pages-api", () => ({
      pagesApi: {
        create: async () => {
          throw new Error("network fail")
        },
      },
    }))
    const key = `${Date.now()}-${Math.random()}`
    const errMod = await import(`./page-actions?err=${key}`)
    const { props } = makeProps()
    // Should not throw
    await errMod.createPageActions(props).handleNewPage()
  })
})
