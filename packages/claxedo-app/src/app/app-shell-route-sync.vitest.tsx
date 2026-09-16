import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { useAppShellRouteSync } from "./app-shell-route-sync"
import type { ContentMeta } from "./workbench/state/index"
import { sessionRoute, workspaceSessionRoute } from "@/platform/identity/route"

const directory = "/work/route-sync"

function session(id: string, sessionId: string): ContentMeta {
  return { id, type: "session", directory, sessionId }
}

function mount(input: { pathname: string; params: Record<string, string>; kind: "session" | "workspace-session" | "workspace"; initial: ContentMeta }) {
  const [surface, setSurface] = createSignal<ContentMeta | undefined>(input.initial)
  const [pathname, setPathname] = createSignal(input.pathname)
  const navigate = vi.fn((to: string) => setPathname(to))
  const Capture = () => {
    useAppShellRouteSync({
      activeSurface: surface,
      activeDirectory: () => directory,
      projects: () => [],
      findSurface: () => undefined,
      navigate: navigate as never,
      params: input.params,
      hash: () => "",
      pathname,
      routeDirectory: () => (input.kind === "session" ? undefined : input.params.workspaceId),
      routeId: () => (input.kind === "session" ? undefined : input.params.workspaceId),
      search: () => "",
      sessionInventory: () => ({ byWorkspace: {}, byProject: {} }),
      shellRouteKind: () => input.kind,
    })
    return null
  }
  render(() => <Capture />)
  return { navigate, setSurface, pathname }
}

afterEach(() => cleanup())

describe("useAppShellRouteSync follows pane focus", () => {
  test("focusing a pane holding another session moves a /s/<id> route to that session", () => {
    const h = mount({
      pathname: sessionRoute("ses_a"),
      params: { sessionId: "ses_a" },
      kind: "session",
      initial: session("content-a", "ses_a"),
    })
    expect(h.navigate).not.toHaveBeenCalled()

    h.setSurface(session("content-b", "ses_b"))
    expect(h.navigate).toHaveBeenCalledTimes(1)
    expect(h.navigate).toHaveBeenCalledWith(sessionRoute("ses_b"), { replace: true })

    h.setSurface(session("content-a", "ses_a"))
    expect(h.navigate).toHaveBeenLastCalledWith(sessionRoute("ses_a"), { replace: true })
  })

  test("focusing the pane the route already names does not navigate", () => {
    const h = mount({
      pathname: sessionRoute("ses_a"),
      params: { sessionId: "ses_a" },
      kind: "session",
      initial: session("content-b", "ses_b"),
    })
    h.setSurface(session("content-a", "ses_a"))
    expect(h.navigate).not.toHaveBeenCalled()
  })

  test("focusing another pane on a workspace session route keeps the workspace spine", () => {
    const workspaceId = "ws_main"
    const backed = (id: string, sessionId: string): ContentMeta => ({
      ...session(id, sessionId),
      content: {
        type: "session",
        directory,
        sessionId,
        sessionRef: { sessionId, host: "workspace", workspaceId },
      },
    })
    const h = mount({
      pathname: workspaceSessionRoute(workspaceId, "ses_a"),
      params: { workspaceId, sessionId: "ses_a" },
      kind: "workspace-session",
      initial: backed("content-a", "ses_a"),
    })
    h.setSurface(backed("content-b", "ses_b"))
    expect(h.navigate).toHaveBeenCalledWith(workspaceSessionRoute(workspaceId, "ses_b"), { replace: true })
  })
})
