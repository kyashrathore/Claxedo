import { beforeAll, describe, expect, test } from "bun:test"
import { workspacePageRoute } from "../../shell/identity/route"
import type { PageActionProps } from "./page-actions"

let createPageActions: typeof import("./page-actions").createPageActions

beforeAll(async () => {
  const mod = await import("./page-actions")
  createPageActions = mod.createPageActions
})

function makeProps() {
  const openPagesIndexCalls: Array<string | undefined> = []
  const navigateCalls: string[] = []

    const props: PageActionProps & { canUsePages?: () => boolean } = {
      navigate: (path: string) => navigateCalls.push(path),
      activeWorkspaceId: () => "/workspace/main",
      projects: () => [{ id: "p1", worktree: "/workspace/main" }],
      canUsePages: () => true,
      state: {
        layout: {
          openPagesIndex: (directory?: string) => {
            openPagesIndexCalls.push(directory)
            return "page-index-1"
          },
        },
      },
    }

  return { props, openPagesIndexCalls, navigateCalls }
}

describe("createPageActions", () => {
  test("handleNewPage opens pages-index for active workspace", () => {
    const { props, openPagesIndexCalls, navigateCalls } = makeProps()
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual(["/workspace/main"])
    expect(navigateCalls).toEqual([workspacePageRoute("/workspace/main", "__index__")])
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

  test("handleNewPage opens pages-index even when signed page access is unavailable", () => {
    const { props, navigateCalls, openPagesIndexCalls } = makeProps()
    props.canUsePages = () => false
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual(["/workspace/main"])
    expect(navigateCalls).toEqual([workspacePageRoute("/workspace/main", "__index__")])
  })

  test("handleNewPage opens pages-index while signed page access is unresolved", () => {
    const { props, navigateCalls, openPagesIndexCalls } = makeProps()
    delete props.canUsePages
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual(["/workspace/main"])
    expect(navigateCalls).toEqual([workspacePageRoute("/workspace/main", "__index__")])
  })
})
