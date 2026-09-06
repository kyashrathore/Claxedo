import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { workspacePageRoute } from "@/platform/identity/route"
import type { PageActionProps } from "./page-actions"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"

beforeEach(() => configureAppPortsForTest())

let createPageActions: typeof import("./page-actions").createPageActions

beforeAll(async () => {
  const mod = await import("./page-actions")
  createPageActions = mod.createPageActions
})

function makeProps() {
  const openPagesIndexCalls: Array<Parameters<PageActionProps["state"]["layout"]["openPagesIndex"]>> = []
  const navigateCalls: string[] = []

    const props: PageActionProps = {
      navigate: (path: string) => navigateCalls.push(path),
      activeDirectory: () => "/workspace/main",
      activeWorkspaceRouteId: () => "p1",
      projects: () => [{ id: "p1", worktree: "/workspace/main" }],
      workspaceRouteId: (directory) => directory === "/workspace/main" ? "p1" : undefined,
      state: {
        layout: {
          openPagesIndex: (...args) => {
            openPagesIndexCalls.push(args)
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
    expect(openPagesIndexCalls).toEqual([["/workspace/main", { workspaceRouteId: "p1" }]])
    expect(navigateCalls).toEqual([workspacePageRoute("p1", "__index__")])
  })

  test("handleNewPage falls back to first project when no active workspace", () => {
    const { props, openPagesIndexCalls } = makeProps()
    props.activeDirectory = () => undefined
    props.activeWorkspaceRouteId = () => undefined
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual([["/workspace/main", { workspaceRouteId: "p1" }]])
  })

  test("handleNewPage skips navigation when no workspace dir is available", () => {
    const { props, navigateCalls, openPagesIndexCalls } = makeProps()
    props.activeDirectory = () => undefined
    props.activeWorkspaceRouteId = () => undefined
    props.projects = () => []
    const actions = createPageActions(props)
    actions.handleNewPage()
    expect(openPagesIndexCalls).toEqual([[]])
    expect(navigateCalls).toEqual([])
  })

  test("uses the active route identity when a shared physical directory is ambiguous", () => {
    const { props, openPagesIndexCalls, navigateCalls } = makeProps()
    props.activeDirectory = () => "/workspace"
    props.activeWorkspaceRouteId = () => "ws_selected"
    props.workspaceRouteId = () => undefined

    createPageActions(props).handleNewPage()

    expect(openPagesIndexCalls).toEqual([["/workspace", { workspaceRouteId: "ws_selected" }]])
    expect(navigateCalls).toEqual([workspacePageRoute("ws_selected", "__index__")])
  })

})
