import { createEffect, on, type Accessor } from "solid-js"
import type { Navigator, Params } from "@solidjs/router"

import { realDirectory, type ContentMeta } from "./workbench/state/index"
import { markRouteIntentClosed } from "./workbench/state/route-intent"
import { recoverWorkspaceRuntimeRoute, type RuntimeRouteSessionInventory } from "./workbench/state/route-runtime-recovery"
import { focusedSurfaceRouteTarget, surfaceRoute } from "./workbench/state/surface-route"
import {
  parseShellRoute,
  sessionRoute as canonicalSessionRoute,
  workspaceRoute,
  workspaceRouteWithId,
  type ShellRoute,
} from "@/platform/identity/route"

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
  createEffect(() => {
    const routeId = input.routeId()
    if (!routeId) return
    const route = parseShellRoute(input.pathname())
    if (!("workspaceId" in route) || route.workspaceId === routeId) return
    const target = workspaceRouteWithId(route, routeId)
    if (target) input.navigate(`${target}${input.search()}${input.hash()}`, { replace: true })
  })

  createEffect(() => {
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
      if (target && input.pathname() !== target) {
        input.navigate(target, { replace: true })
        return
      }
    }
    const target = recoverWorkspaceRuntimeRoute({
      routeDir: input.routeDirectory(),
      sessionId,
      byWorkspace: input.sessionInventory().byWorkspace,
      byProject: input.sessionInventory().byProject,
    })
    if (target && input.pathname() !== target) input.navigate(target, { replace: true })
  })

  createEffect(() => {
    if (input.pathname() !== "/") return
    const surface = input.activeSurface()
    if (!surface) return
    const dir = realDirectory(surface.directory) ?? input.activeDirectory()
    if (!dir) return
    input.navigate(surfaceRoute(dir, surface) ?? workspaceRoute(dir), { replace: true })
  })

  createEffect(
    on(
      input.activeSurface,
      (surface) => {
        if (
          input.params.sessionId ||
          input.params.id ||
          input.shellRouteKind() === "session" ||
          input.shellRouteKind() === "workspace"
        ) return
        const target = focusedSurfaceRouteTarget({
          route: {
            ...input.params,
            marketplace: input.shellRouteKind() === "marketplace",
            workgraph: input.shellRouteKind() === "workgraph",
            workspaceWorkGraph: input.shellRouteKind() === "workspaceWorkGraph",
            newTask: input.shellRouteKind() === "newTask",
          },
          surface,
          routeWorkspaceKey: input.routeDirectory(),
          activeDirectory: input.activeDirectory(),
        })
        if (target && input.pathname() !== target) input.navigate(target, { replace: true })
      },
      { defer: true },
    ),
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
