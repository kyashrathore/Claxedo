import { routeMatchesSurface, surfaceRoute } from "../state/surface-route"
import { realDirectory, type ContentMeta } from "../state/index"
import type { ActionProps } from "./shared"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"
import { workspaceRouteIdentity } from "@/features/workspaces/lib/workspace-display"
import { urlRoutingEnabled } from "@/lib/runtime-mode"

type OpenSurfaceActionProps = Pick<
  ActionProps,
  "params" | "projects" | "routeDirectory" | "routeId" | "activeDirectory" | "flowLog"
> & {
  state: {
    wb: {
      state: {
        focusedPaneId?: string | null
      }
    }
  }
}

function safeWindowPathname() {
  if (typeof window === "undefined") return undefined
  try {
    return window.location.pathname
  } catch {
    return undefined
  }
}

function workspaceRouteKey(props: OpenSurfaceActionProps, workspaceDir: string) {
  const currentRouteId = props.routeId()
  if (currentRouteId && sameWorkspaceDirectory(props.routeDirectory(), workspaceDir)) return currentRouteId

  const explicitWorkspaceId = workspaceRouteIdentity(props.projects(), workspaceDir)?.routeId
  if (explicitWorkspaceId) return explicitWorkspaceId

  // A project's root worktree is represented by the project id. Sandboxes
  // without an explicit workspace id deliberately retain their directory key;
  // routing them through the parent project id would select the main worktree.
  return props.projects().find((project) => project.worktree === workspaceDir)?.id ?? workspaceDir
}

export function createOpenSurfaceActions(props: OpenSurfaceActionProps) {
  const handleTabSelect = (tab: ContentMeta) => {
    props.flowLog("tab select", {
      surfaceId: tab.id,
      tabType: tab.type,
      tabDir: tab.directory,
      tabSessionId: tab.type === "session" || tab.type === "context" ? tab.sessionId : undefined,
      tabPageId: tab.type === "page" ? tab.pageId : undefined,
      tabTerminalId: tab.type === "terminal" ? tab.terminalId : undefined,
      routeDir: props.routeDirectory(),
      routeSession: props.params.id,
      routePage: props.params.pageId,
      focusedGroup: props.state.wb.state.focusedPaneId,
    })

    // Every workbench tab routes to a HiddenRouteOutlet - the router tree does
    // not render the workbench, the URL is a mirror. Mirror it with a raw
    // history write: a real router navigation in the Solid 2 router (2.0-next)
    // rebuilds the matched tree from the root, remounting RuntimeProviders and
    // the entire shell (measured: runtime.providersMounted + a 150ms+ frame per
    // navigation, retained panes and their content ids reset, rail rows
    // detached under a held pointer). The router deliberately stays stale
    // during runtime; consumers that need the current session check the live
    // window URL (route-bridge's directSessionRouteStillCurrent).
    const mirrorRoute = (route: string, details: Record<string, unknown>) => {
      const pathname = safeWindowPathname()
      if (pathname === route) return
      props.flowLog("navigate", { reason: "tab-select", path: route, ...details })
      // Desktop routes with MemoryRouter over a file:// document: writing the
      // route there strands reloads on a chrome-error page. See urlRoutingEnabled.
      if (!urlRoutingEnabled()) return
      window.history.replaceState(window.history.state, "", route)
    }

    if (tab.type === "marketplace" || tab.type === "workgraph") {
      const route = surfaceRoute("", tab)
      if (route) mirrorRoute(route, { surfaceId: tab.id, tabType: tab.type })
      return
    }

    const workspaceDir = tab.type === "page" ? (realDirectory(tab.directory) ?? props.activeDirectory()) : tab.directory
    if (!workspaceDir) return

    // The route mirror passes the DIRECTORY: surfaceRoute prefers it, keeping
    // this writer form-consistent with the rail's replaceSessionUrl.
    const route = surfaceRoute(workspaceDir, tab)
    if (!route) return

    const syncRoute = () => {
      // Deferred match check: another writer (rail activation, route bridge)
      // may have caught the route up between the click and this microtask.
      const workspaceId = workspaceRouteKey(props, workspaceDir)
      if (routeMatchesSurface(props.params, workspaceId, tab, props.routeId() ?? props.routeDirectory())) return
      mirrorRoute(route, {
        surfaceId: tab.id,
        tabType: tab.type,
        workspaceDir,
        sessionId: tab.type === "session" || tab.type === "context" ? tab.sessionId : undefined,
        pageId: tab.type === "page" ? tab.pageId : undefined,
        terminalId: tab.type === "terminal" ? tab.terminalId : undefined,
      })
    }
    queueMicrotask(syncRoute)
  }

  return {
    handleTabSelect,
  }
}
