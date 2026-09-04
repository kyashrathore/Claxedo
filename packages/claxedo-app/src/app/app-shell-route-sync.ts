import { findProjectForDirectory, type ProjectInventoryEntry } from "@/features/session/ui/components/session-new-workspace-options"
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
import { workspaceRouteId, type WorkspaceRouteProject } from "@/platform/identity/workspace-route"

export function useAppShellRouteSync(input: {
  activeSurface: Accessor<ContentMeta | undefined>
  activeDirectory: Accessor<string | undefined>
  projects: Accessor<WorkspaceRouteProject[]>
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
    const routeId = workspaceRouteId(input.projects(), dir)
    const target = surfaceRoute(routeId, surface) ?? (routeId ? workspaceRoute(routeId) : undefined)
    if (target) input.navigate(target, { replace: true })
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
          },
          surface,
          routeWorkspaceKey: input.routeId(),
          activeRouteId: workspaceRouteId(input.projects(), realDirectory(surface?.directory) ?? input.activeDirectory()),
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
      const route = surfaceRoute(workspaceRouteId(input.projects(), dir), nextSurface)
      if (!route) return
      input.navigate(route, { replace: true })
      return
    }
    const fallbackDir = realDirectory(closedSurface.directory) ?? input.activeDirectory() ?? input.routeDirectory()
    if (fallbackDir) {
      markRouteIntentClosed({ workspaceId: fallbackDir })
      const routeId = workspaceRouteId(input.projects(), fallbackDir)
      if (routeId) input.navigate(workspaceRoute(routeId), { replace: true })
      return
    }
    input.navigate("/", { replace: true })
  }

  return {
    handleTabClose,
  }
}

type SessionRevocationNavigate = (to: string, options: { replace: boolean }) => unknown

/** Close all retained panes for a revoked session and leave its active deep link. */
/**
 * Panes whose workspace no longer exists — a project removed while this tab was
 * away, or a wiped dev store — must not survive a reload as "live" drafts. The
 * persisted workbench state restores them faithfully, the pane's provider chain
 * bootstraps the directory, every request 404s/503s, the events stream
 * reconnects, and the bootstrap repeats: the toast-and-retry loop. Once the
 * project inventory has actually loaded, close every session surface whose
 * directory it does not know, and leave a deep link into one for the root.
 *
 * Decided on the inventory only after it has loaded: an empty list while it is
 * still fetching must not sweep the panes it would have vouched for.
 */
export function applyStaleWorkspaceSweep(input: {
  inventoryReady: boolean
  inventory: readonly ProjectInventoryEntry[]
  activeSurfaceId: () => string | null | undefined
  surfaces: () => ContentMeta[]
  closeContent: (id: string, reason: "panic") => void
  navigate: SessionRevocationNavigate
}) {
  if (!input.inventoryReady) return []
  const stale = input.surfaces().filter((surface) => {
    if (surface.type !== "session" && surface.type !== "context") return false
    const directory = realDirectory(surface.directory)
    if (!directory) return false
    return !findProjectForDirectory(input.inventory, [directory])
  })
  if (stale.length === 0) return []

  const activeSurfaceId = input.activeSurfaceId()
  const activeWasStale = stale.some((surface) => surface.id === activeSurfaceId)
  for (const surface of stale) input.closeContent(surface.id, "panic")
  if (activeWasStale) input.navigate("/", { replace: true })
  return stale.map((surface) => surface.id)
}

export function applySessionAccessRevocation(input: {
  sessionId: string
  workspaceId: string
  activeSurfaceId: () => string | null | undefined
  surfaces: () => ContentMeta[]
  closeContent: (id: string) => void
  navigate: SessionRevocationNavigate
}) {
  const matches = input.surfaces().filter((surface) =>
    (surface.type === "session" || surface.type === "context") && surface.sessionId === input.sessionId
  )
  if (matches.length === 0) return

  const activeSurfaceId = input.activeSurfaceId()
  const activeWasRevoked = matches.some((surface) => surface.id === activeSurfaceId)
  for (const surface of matches) input.closeContent(surface.id)
  if (activeWasRevoked) input.navigate(workspaceRoute(input.workspaceId), { replace: true })
}
