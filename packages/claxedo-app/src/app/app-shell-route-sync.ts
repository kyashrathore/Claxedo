import { createEffect, type Accessor } from "solid-js"
import type { Navigator, Params } from "@solidjs/router"

import { realDirectory, type ContentMeta } from "./workbench/state/index"
import { markRouteIntentClosed } from "./workbench/state/route-intent"
import {
  recoverWorkspaceRuntimeRoute,
  type RuntimeRouteSessionInventory,
} from "./workbench/state/route-runtime-recovery"
import { focusedSurfaceRouteTarget, surfaceRoute } from "./workbench/state/surface-route"
import {
  parseShellRoute,
  sessionRoute as canonicalSessionRoute,
  workspaceRoute,
  workspaceRouteWithId,
  type ShellRoute,
} from "@/platform/identity/route"
import { sameWorkspaceDirectory } from "@/platform/runtime/agent/signed-workspace"

export function useAppShellRouteSync(input: {
  activeSurface: Accessor<ContentMeta | undefined>
  activeDirectory: Accessor<string | undefined>
  findSurface: (predicate: (surface: ContentMeta) => boolean) => ContentMeta | undefined
  navigate: Navigator
  params: Params
  hash: Accessor<string>
  pathname: Accessor<string>
  routeDirectory: Accessor<string | undefined>
  routeId: Accessor<string | undefined>
  search: Accessor<string>
  sessionInventory: Accessor<RuntimeRouteSessionInventory>
  shellRouteKind: Accessor<ShellRoute["kind"]>
}) {
  // Each of these three rules derives a route, then navigates to it. The
  // derivation is the compute; the navigate is the effect. Splitting them buys
  // two things: the query string and hash stop being dependencies of a rule
  // that only reads them to rebuild the URL it is about to visit, and an
  // unchanged target no longer re-issues `navigate`.
  createEffect(
    () => {
      const routeId = input.routeId()
      if (!routeId) return undefined
      const route = parseShellRoute(input.pathname())
      if (!("workspaceId" in route) || route.workspaceId === routeId) return undefined
      // The id form is the canonical workspace URL, including when the current
      // segment is the directory form for the SAME workspace: `/w/<id>` is what
      // the rail, the deep-link specs and every shared link expect to see.
      // This rule was briefly suppressed for a same-workspace directory segment
      // because flipping `:workspaceId` re-ran workspace resolution and rebuilt
      // the rail mid-interaction — but that traded a product contract for a
      // render cost, and the cost is now paid where it belongs: a router
      // remount no longer discards workbench state (see
      // `ClaxedoStateProvider`'s once-per-document prune).
      return workspaceRouteWithId(route, routeId)
    },
    (target) => {
      if (target) input.navigate(`${target}${input.search()}${input.hash()}`, { replace: true })
    },
  )

  createEffect(
    () => {
      const sessionId = input.params.sessionId ?? input.params.id
      if (input.routeDirectory() === "/workspace" && sessionId) {
        const meta = input.findSurface(
          (item) =>
            (item.type === "session" || item.type === "context") &&
            item.sessionId === sessionId &&
            !!item.directory &&
            item.directory !== "/workspace",
        )
        const target = meta?.directory ? canonicalSessionRoute(sessionId) : undefined
        if (target && input.pathname() !== target) return target
      }
      const target = recoverWorkspaceRuntimeRoute({
        routeDir: input.routeDirectory(),
        sessionId,
        byWorkspace: input.sessionInventory().byWorkspace,
        byProject: input.sessionInventory().byProject,
      })
      return target && input.pathname() !== target ? target : undefined
    },
    (target) => {
      if (target) input.navigate(target, { replace: true })
    },
  )

  createEffect(
    () => {
      if (input.pathname() !== "/") return undefined
      const surface = input.activeSurface()
      if (!surface) return undefined
      const dir = realDirectory(surface.directory) ?? input.activeDirectory()
      if (!dir) return undefined
      const workspaceId =
        input.routeId() && sameWorkspaceDirectory(input.routeDirectory(), dir) ? input.routeId()! : dir
      return surfaceRoute(workspaceId, surface) ?? workspaceRoute(workspaceId)
    },
    (target) => {
      if (target) input.navigate(target, { replace: true })
    },
  )

  createEffect(
    input.activeSurface,
    (surface) => {
      if (
        input.params.sessionId ||
        input.params.id ||
        input.shellRouteKind() === "session" ||
        input.shellRouteKind() === "workspace"
      )
        return
      const target = focusedSurfaceRouteTarget({
        route: {
          ...input.params,
          marketplace: input.shellRouteKind() === "marketplace",
          workgraph: input.shellRouteKind() === "workgraph",
          workspaceWorkGraph: input.shellRouteKind() === "workspaceWorkGraph",
          newTask: input.shellRouteKind() === "newTask",
        },
        surface,
        routeWorkspaceKey: input.routeId() ?? input.routeDirectory(),
        routeDirectory: input.routeDirectory(),
        routeId: input.routeId(),
        activeDirectory: input.activeDirectory(),
      })
      if (target && input.pathname() !== target) input.navigate(target, { replace: true })
    },
    { defer: true },
  )

  const handleTabClose = (nextSurface: ContentMeta | undefined, closedSurface: ContentMeta) => {
    const closedDirectory = realDirectory(closedSurface.directory)
    markRouteIntentClosed({
      workspaceId: closedDirectory,
      sessionId: closedSurface.sessionId,
    })
    if (closedSurface.sessionId === "new" || !closedSurface.sessionId) {
      markRouteIntentClosed({ workspaceId: closedDirectory })
    }
    markRouteIntentClosed({
      sessionId: closedSurface.sessionId,
    })
    if (nextSurface) {
      const dir = realDirectory(nextSurface.directory) ?? input.activeDirectory() ?? input.routeDirectory() ?? ""
      const route = surfaceRoute(dir, nextSurface)
      if (!route) return
      input.navigate(route, { replace: true })
      return
    }
    const fallbackDir = realDirectory(closedSurface.directory) ?? input.activeDirectory() ?? input.routeDirectory()
    if (fallbackDir) {
      markRouteIntentClosed({ workspaceId: fallbackDir })
      input.navigate(workspaceRoute(fallbackDir), { replace: true })
      return
    }
    input.navigate("/", { replace: true })
  }

  return {
    handleTabClose,
  }
}
