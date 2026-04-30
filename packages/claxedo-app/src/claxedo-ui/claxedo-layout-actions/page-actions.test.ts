import { beforeAll, describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"

let createPageActions: typeof import("./page-actions").createPageActions

beforeAll(async () => {
  const mod = await import("./page-actions")
  createPageActions = mod.createPageActions
})

function makeProps() {
  const openPagesIndexCalls: Array<string | undefined> = []
  const navigateCalls: string[] = []

  const props = {
    navigate: (path: string) => navigateCalls.push(path),
    activeWorkspaceId: () => "/workspace/main",
    projects: () => [{ worktree: "/workspace/main" }],
    params: {},
    globalSDK: {},
    claxedo: {} as any,
    state: {
      layout: {
        openPagesIndex: (directory?: string) => {
          openPagesIndexCalls.push(directory)
          return "page-index-1"
        },
      },
    } as any,
  } as any

  return { props, openPagesIndexCalls, navigateCalls }
}

describe("createPageActions", () => {
  test("handleNewPage opens pages-index for active workspace", () => {
    const { props, openPagesIndexCalls, navigateCalls } = makeProps()
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual(["/workspace/main"])
    expect(navigateCalls).toEqual([`/${base64Encode("/workspace/main")}/page/__index__`])
  })

  test("handleNewPage falls back to first project when no active workspace", () => {
    const { props, openPagesIndexCalls } = makeProps()
    props.activeWorkspaceId = () => undefined
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual(["/workspace/main"])
  })

  test("handleNewPage skips navigation when no workspace dir is available", () => {
    const { props, navigateCalls, openPagesIndexCalls } = makeProps()
    props.activeWorkspaceId = () => undefined
    props.projects = () => []
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual([undefined])
    expect(navigateCalls).toEqual([])
  })
})
