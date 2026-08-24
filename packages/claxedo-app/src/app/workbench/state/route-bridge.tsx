import { createEffect } from "solid-js"
// target-layer: data — Phase 1/2 will absorb
import { createTrackedEffect, createMemo, createSignal, onCleanup, type ParentProps } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useLayout, type LocalProject } from "@/app/providers/layout"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useServer } from "@/app/connection/server"
import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useClaxedoEventsOptional } from "../../integrations/claxedo-events"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { wasRolledBackDraft } from "../../../features/session/submit/rolled-back-drafts"
import { suppressedByFastSessionSwitch } from "@/platform/runtime/session-switch"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import {
  directorySessionCacheQueryOptions,
  emptySessionInventory,
  sessionInventoryQueryOptions,
  type DirectorySessionCacheValue,
} from "../../../features/session/data/sync/queries"
import { useDirectorySessionCacheActions } from "../../../features/session/data/sync/directory-session-cache"
import { parseShellRoute, shellRouteDirectory, workspaceSessionRoute, workspaceRoute } from "@/platform/identity/route"
import {
  centralSessionRef,
  hasBacking,
  sameSessionRef,
  sessionRefForWorkspaceSession,
  type HarnessRef,
  type SessionRef,
  type WorkspaceSessionBacking,
} from "@/platform/identity/session-ref"
import { usePrincipal } from "@/platform/auth/identity-provider"
import { documentsAccess } from "@/features/documents/access"
import { queryClient } from "@/platform/query/query-client"
import type { SessionInventoryRow } from "../../../features/session/data/query/types"
import { ensureLocalProject } from "../../../features/workspaces/data/query/project-ensure"
import { useAgentHooks } from "./agent-status-listener"
import { createBatchAutoTabListener } from "./batch-autotab"
import { useClaxedoState } from "./"
import { projectWorkspaceDirectories } from "../../../features/workspaces/lib/workspace-display"
import {
  useWorkspaceRouteResolution,
  WorkspaceRouteResolutionProvider,
} from "@/app/routes/workspace-route-resolution-provider"
import {
  indexSessionTitleInventory,
  sessionTitleFromSources,
  sessionTitleSignature,
} from "../../../features/session/lib/session-title-sync"
import { createRouteIntentAdapter, isRouteIntentClosed, sessionInventoryTarget } from "./route-intent"
import { routeSessionHarness } from "./route-session-harness"
import {
  fetchRouteSessionMeta,
  probeRouteSessionDirectory,
  routeBridgeSessionConfigHarness,
  routeKnownSessionDirectory,
  routeSessionMetaIsCentral,
  routeSessionDirectory,
  routeSessionWorkspaceBacking,
} from "./route-bridge-resolution"
export { recoverWorkspaceRuntimeRoute } from "./route-runtime-recovery"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
  newSessionDeepLinkRoute,
} from "./route-deep-links"
import type { ProjectItem } from "../rail/domain-types"

export function projectToProjectItem(project: LocalProject): ProjectItem {
  return {
    id: project.id ?? project.worktree,
    worktree: project.worktree,
    name: project.name,
    icon: project.icon,
    expanded: project.expanded,
    sandboxes: project.sandboxes,
    workspaces: (project as any).workspaces, // as-any: Claxedo project payload includes workspaces before upstream LocalProject exposes it.
    commands: project.commands,
  }
}

// Pure resolution + session-probe helpers now live in ./route-bridge-resolution.
// Re-exported below to keep this module's public surface unchanged.
export { probeRouteSessionDirectory, routeKnownSessionDirectory, routeSessionDirectory, routeSessionWorkspaceBacking }

export function ClaxedoRouteStateBridge(props: ParentProps) {
  const state = useClaxedoState()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({
      baseUrl: globalSDK.url,
    }),
  )
  const sessionInventory = createMemo(() => sessionInventoryQuery.data ?? emptySessionInventory<SessionInventoryRow>())
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const principal = usePrincipal()
  const canUseDocuments = () => documentsAccess({ principal: principal(), serverUrl: server.url })

  useAgentHooks()
  const events = useClaxedoEventsOptional()

  createTrackedEffect(() => {
    if (!events) return
    const unsubscribe = events.on("session.lifecycle", (event) => {
      if (event.phase !== "created" || !event.draftId || !event.sessionID) return
      const fastSwitch =
        typeof window === "undefined"
          ? undefined
          : (
              window as typeof window & {
                __claxedoFastSessionSwitch?: { sessionId: string; until: number }
              }
            ).__claxedoFastSessionSwitch
      if (fastSwitch && Date.now() <= fastSwitch.until && event.sessionID !== fastSwitch.sessionId) return
      if (wasRolledBackDraft(event.draftId)) return
      const info = event.info && typeof event.info === "object" ? (event.info as { title?: unknown }) : undefined
      const draft = state.meta.find((meta) => meta.type === "draft-session" && meta.draftId === event.draftId)
      const sessionRef =
        draft?.content?.sessionRef ??
        sessionRefForWorkspaceSession({
          sessionId: event.sessionID,
          directory: event.directory,
        })
      state.layout.completeDraftSession({
        draftId: event.draftId,
        directory: event.directory,
        sessionId: event.sessionID,
        ...(typeof info?.title === "string" ? { title: info.title } : {}),
        ...(sessionRef ? { sessionRef } : {}),
      })
    })
    return unsubscribe
  })

  // The SDK event bus installs owner cleanup internally. Its contexts and the
  // adapter closures are stable for this bridge's lifetime, so register during
  // component setup; doing it inside a tracked effect makes the primitive's
  // internal `onCleanup` illegal under Solid 2.
  createBatchAutoTabListener({
    listen: globalSDK.event.listen as any, // as-any: auto-tab listener consumes only the SDK event.listen subset.
    adapters: {
      addSession: (dir, sid, title) => {
        const fastSwitch =
          typeof window === "undefined"
            ? undefined
            : (
                window as typeof window & {
                  __claxedoFastSessionSwitch?: { sessionId: string; until: number }
                }
              ).__claxedoFastSessionSwitch
        if (fastSwitch && Date.now() <= fastSwitch.until && sid !== fastSwitch.sessionId) return ""
        const workspace = routeSessionWorkspaceBacking({
          projects: projectsQuery.data ?? [],
          directory: dir,
        })
        return state.layout.openSession(dir, sid, title, {
          focus: false,
          sessionRef: sessionRefForWorkspaceSession({
            sessionId: sid,
            directory: dir,
            ...(workspace ? { workspace } : {}),
          }),
        })
      },
      addTerminal: (dir, tid, title) => state.layout.openTerminal(dir, tid, title, { focus: false }),
      findSession: (dir, sid) =>
        state.meta.find((m) => m.type === "session" && m.directory === dir && m.sessionId === sid),
      findTerminal: (dir, tid) =>
        state.meta.find((m) => m.type === "terminal" && m.directory === dir && m.terminalId === tid),
    },
    projects: () => {
      return (projectsQuery.data ?? []).map((p) => ({ worktree: p.worktree, sandboxes: p.sandboxes }))
    },
  })

  const openProjectFromDeepLink = async (directory: string, route = workspaceRoute(directory)) => {
    if (server.isLocal()) {
      await ensureLocalProject({
        baseUrl: globalSDK.url,
        request: platform.fetch,
        directory,
        projectsQuery: queryOptions.projects(),
      })
    }
    layout.projects.open(directory)
    navigate(route)
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return
    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void openProjectFromDeepLink(directory)
    }
    for (const link of collectNewSessionDeepLinks(urls)) {
      void openProjectFromDeepLink(link.directory, newSessionDeepLinkRoute(link, workspaceSessionRoute))
    }
  }

  createTrackedEffect(() => {
    if (typeof window === "undefined") return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    window.addEventListener(deepLinkEvent, handler as EventListener)
    return () => window.removeEventListener(deepLinkEvent, handler as EventListener)
  })

  const shellRoute = createMemo(() => parseShellRoute(location.pathname))
  const routeWorkspaceKey = createMemo(() => shellRouteDirectory(shellRoute()))
  const routeResolution = useWorkspaceRouteResolution(() => location.pathname)
  const routeDirectory = createMemo(() => routeResolution()?.directory)
  const routeWorkspaceBacking = createMemo(() => {
    const routeKey = routeWorkspaceKey()
    const directory = routeDirectory()
    if (!routeKey || !directory) return
    const inventoryBacking = routeSessionWorkspaceBacking({
      projects: projectsQuery.data ?? [],
      directory,
      workspaceId: routeKey,
    })
    if (inventoryBacking) return inventoryBacking
    const routeBacking = sessionWorkspaceRuntimeRef({ directory: routeKey })
    if (!routeBacking) return
    // The canonical `/w/ws_…` route is workspace authority before project
    // inventory hydrates. Use the relay-only, non-provisioning kind until the
    // inventory above supplies the real cloud vs user-hosted kind. A legacy
    // filesystem route cannot resolve a runtime ref and remains local.
    return routeBacking
  })
  const workspaceBackingForRouteDirectory = (
    directory: Parameters<typeof routeSessionWorkspaceBacking>[0]["directory"],
  ): WorkspaceSessionBacking | undefined => {
    const routed = routeDirectory()
    if (routed && sameWorkspaceDirectory(directory, routed)) return routeWorkspaceBacking()
    return routeSessionWorkspaceBacking({
      projects: projectsQuery.data ?? [],
      directory,
    })
  }
  const routeSessionId = createMemo(() => {
    const route = shellRoute()
    if (route.kind === "session") return route.sessionId
    if (route.kind === "workspace-session") return route.sessionId
    if (route.kind === "legacy-directory") return route.sessionId
    return undefined
  })
  const sessionId = createMemo(() => params.sessionId ?? params.id ?? routeSessionId())
  const pageId = createMemo(() => params.pageId)
  const terminalId = createMemo(() => params.terminalId)
  const shellRouteKind = createMemo(() => shellRoute().kind)
  const routeSessionCacheQuery = useQuery(() =>
    directorySessionCacheQueryOptions({
      directory: routeDirectory() ?? "__claxedo_route_without_workspace__",
    }),
  )
  const routeSession = createMemo(() => {
    const wsId = routeDirectory()
    const id = sessionId()
    if (!wsId || !id) return
    return routeSessionCacheQuery.data?.session.find((s) => s.id === id)
  })
  const directorySessions = (directory: string) =>
    queryClient.getQueryData<DirectorySessionCacheValue>(directorySessionCacheQueryOptions({ directory }).queryKey)
      ?.session ?? []
  const sessionTitleInventoryIndex = createMemo(() => indexSessionTitleInventory(sessionInventory()))
  const sessionTitleFromInventory = (sessionId: string, directory?: string, provisionalTitle?: string) => {
    return sessionTitleFromSources({
      sessionId,
      directory,
      directorySessions,
      provisionalTitle,
      inventoryIndex: sessionTitleInventoryIndex(),
    })
  }
  const routeResolutionDirectories = () =>
    [
      ...(projectsQuery.data ?? []).flatMap(projectWorkspaceDirectories),
      ...state.meta.all().map((meta) => meta.directory),
    ].filter(
      (directory, index, all): directory is string =>
        !!directory && directory !== "/workspace" && all.indexOf(directory) === index,
    )
  const cachedRouteSessionTarget = (sessionId: string) => {
    for (const directory of routeResolutionDirectories()) {
      const session = directorySessions(directory).find((item) => item.id === sessionId)
      if (!session) continue
      const resolvedDirectory = routeSessionDirectory(session.directory, directory)
      const workspace = routeSessionWorkspaceBacking({
        projects: projectsQuery.data ?? [],
        directory: resolvedDirectory,
        workspaceId: session.workspaceID,
      })
      const harness = routeSessionHarness(session) ?? activeSurfaceHarnessForSession(sessionId, resolvedDirectory)
      return {
        directory: resolvedDirectory,
        title: session.title,
        sessionRef: sessionRefForWorkspaceSession({
          sessionId,
          directory: resolvedDirectory,
          ...(workspace ? { workspace } : {}),
          ...(harness ? { harness } : {}),
        }),
      }
    }
  }

  const route = createRouteIntentAdapter({
    state,
    warmWorkspace: (directory) => {
      const workspace = workspaceBackingForRouteDirectory(directory)
      void directorySessionCacheActions.ensure({
        directory,
        ...(workspace ? { workspace } : {}),
      })
    },
    inventory: () => ({
      global: sessionInventory().global,
      byWorkspace: sessionInventory().byWorkspace,
      byProject: sessionInventory().byProject,
      loaded: sessionInventory().loaded,
    }),
    currentSessionId: sessionId,
    resolveSession: async (id) => {
      const routed = routeDirectory()
      if (routed && routed !== "/workspace") {
        const workspace = workspaceBackingForRouteDirectory(routed)
        const harness = await routeBridgeSessionConfigHarness({
          serverUrl: getClaxedoServerUrl(),
          sessionID: id,
          workspaceDirectory: routed,
        })
        return {
          directory: routed,
          title: sessionTitleFromInventory(id, routed),
          sessionRef: sessionRefForWorkspaceSession({
            sessionId: id,
            directory: routed,
            ...(workspace ? { workspace } : {}),
            ...(harness ? { harness } : {}),
          }),
        }
      }
      const cached = cachedRouteSessionTarget(id)
      if (cached) return cached
      const session = await fetchRouteSessionMeta({
        serverUrl: getClaxedoServerUrl(),
        sessionID: id,
      })
      if (routeSessionMetaIsCentral(session)) return
      const sessionWorkspaceId =
        typeof session?.workspaceID === "string"
          ? session.workspaceID
          : typeof session?.workspaceId === "string"
            ? session.workspaceId
            : undefined
      const directory =
        routeKnownSessionDirectory(
          typeof session?.directory === "string" ? session.directory : undefined,
          routeResolutionDirectories(),
        ) ??
        (await probeRouteSessionDirectory(id, routeResolutionDirectories())) ??
        sessionWorkspaceId
      if (!directory || directory === "/workspace") return
      const workspace = routeSessionWorkspaceBacking({
        projects: projectsQuery.data ?? [],
        directory,
        workspaceId: sessionWorkspaceId,
      })
      const harness =
        routeSessionHarness(session) ??
        (await routeBridgeSessionConfigHarness({
          serverUrl: getClaxedoServerUrl(),
          sessionID: id,
          workspaceDirectory: directory,
        }))
      return {
        directory,
        title: typeof session?.title === "string" ? session.title : undefined,
        sessionRef: sessionRefForWorkspaceSession({
          sessionId: id,
          directory,
          ...(workspace ? { workspace } : {}),
          ...(harness ? { harness } : {}),
        }),
      }
    },
    canUseDocuments,
    navigate,
  })

  const activeSurface = createMemo(() => {
    const id = state.wb.selectors.focusedContent()
    return id ? state.meta.get(id) : undefined
  })
  const directSessionRouteId = createMemo(() => {
    const route = shellRoute()
    if (route.kind === "session") return route.sessionId
    return undefined
  })
  const activeSurfaceSessionRefHost = createMemo(() => {
    const content = activeSurface()?.content
    if (content?.type === "session") return content.sessionRef?.host
    return undefined
  })
  function activeSurfaceHarnessForSession(sessionId: string, workspaceDir: string): HarnessRef | undefined {
    const surface = activeSurface()
    if (surface?.type !== "session" && surface?.type !== "context") return undefined
    if (surface.sessionId !== sessionId || !sameWorkspaceDirectory(surface.directory, workspaceDir)) return undefined
    if (surface.content?.type !== "session") return undefined
    const harness = surface.content.sessionRef?.harness
    return harness?.id && harness.id !== "opencode" ? harness : undefined
  }
  const routeLocalSessionResolutionMisses = new Set<string>()
  const routeSessionMetaLookups = new Set<string>()
  const routeSessionMetaLookupDone = new Set<string>()
  const routeCentralSessionMeta = new Map<string, SessionRef>()
  const [routeSessionMetaLookupVersion, setRouteSessionMetaLookupVersion] = createSignal(0)
  const markRouteSessionMetaLookupChanged = () => setRouteSessionMetaLookupVersion((version) => version + 1)
  const cachedDirectRouteSessionTarget = (sessionId: string, directories: string[]) => {
    for (const directory of directories) {
      const session = directorySessions(directory).find((item) => item.id === sessionId)
      if (!session) continue
      const resolvedDirectory = routeSessionDirectory(session.directory, directory)
      const harness = routeSessionHarness(session) ?? activeSurfaceHarnessForSession(sessionId, resolvedDirectory)
      return {
        directory: resolvedDirectory,
        title: session.title,
        sessionRef: sessionRefForWorkspaceSession({
          sessionId,
          directory: resolvedDirectory,
          ...(harness ? { harness } : {}),
        }),
      }
    }
  }
  const unresolvedRouteWorkspaceTarget = (directories: string[]) => {
    const routed = routeDirectory()
    if (routed && routed !== "/workspace") return routed
    const active = activeSurface()?.directory
    if (active && active !== "/workspace") return active
    return directories.find((directory) => !!workspaceIdFromRef(directory)) ?? directories[0]
  }

  const resolveRouteSessionFromMeta = (sessionId: string, directories: string[]) => {
    if (routeSessionMetaLookups.has(sessionId)) return true
    if (routeSessionMetaLookupDone.has(sessionId)) return false
    routeSessionMetaLookups.add(sessionId)
    markRouteSessionMetaLookupChanged()
    void fetchRouteSessionMeta({
      serverUrl: getClaxedoServerUrl(),
      sessionID: sessionId,
    })
      .then(async (session) => {
        if (routeSessionMetaIsCentral(session)) {
          const workspaceId =
            typeof session?.workspaceID === "string"
              ? session.workspaceID
              : typeof session?.workspaceId === "string"
                ? session.workspaceId
                : undefined
          const harness = routeSessionHarness(session)
          const sessionRef = centralSessionRef({
            sessionId,
            ...(workspaceId ? { workspaceId } : {}),
            ...(harness ? { harness } : {}),
          })!
          routeCentralSessionMeta.set(sessionId, sessionRef)
          if (directSessionRouteId() !== sessionId) return
          if (isRouteIntentClosed({ sessionId })) return
          state.layout.openCentralSession(sessionId, typeof session?.title === "string" ? session.title : "Session", {
            authoritative: true,
            sessionRef,
          })
          return
        }
        routeCentralSessionMeta.delete(sessionId)
        const workspaceId =
          typeof session?.workspaceID === "string"
            ? session.workspaceID
            : typeof session?.workspaceId === "string"
              ? session.workspaceId
              : undefined
        const directory =
          routeKnownSessionDirectory(
            typeof session?.directory === "string" ? session.directory : undefined,
            directories,
          ) ??
          (await probeRouteSessionDirectory(sessionId, directories)) ??
          workspaceId
        if (!directory || directory === "/workspace") return
        const workspace = routeSessionWorkspaceBacking({
          projects: projectsQuery.data ?? [],
          directory,
          workspaceId,
        })
        const harness =
          routeSessionHarness(session) ??
          (await routeBridgeSessionConfigHarness({
            serverUrl: getClaxedoServerUrl(),
            sessionID: sessionId,
            workspaceDirectory: directory,
          }))
        if (directSessionRouteId() !== sessionId) return
        if (isRouteIntentClosed({ sessionId })) return
        const surface = activeSurface()
        if (
          (surface?.type === "session" || surface?.type === "context") &&
          surface.sessionId === sessionId &&
          sameWorkspaceDirectory(surface.directory, directory)
        )
          return
        state.layout.openSession(directory, sessionId, typeof session?.title === "string" ? session.title : "Session", {
          sessionRef: sessionRefForWorkspaceSession({
            sessionId,
            directory,
            ...(workspace ? { workspace } : {}),
            ...(harness ? { harness } : {}),
          }),
        })
      })
      .catch(() => undefined)
      .finally(() => {
        routeSessionMetaLookups.delete(sessionId)
        routeSessionMetaLookupDone.add(sessionId)
        markRouteSessionMetaLookupChanged()
      })
    return true
  }

  const sessionInfo = createMemo((prev: { workspaceId: string; sessionId: string; title: string } | undefined) => {
    const wsId = routeDirectory()
    const id = sessionId()
    if (!wsId || !id) return undefined
    const session = routeSession()
    if (session?.title) return { workspaceId: wsId, sessionId: id, title: session.title }
    if (prev?.workspaceId === wsId && prev?.sessionId === id) return prev
    return undefined
  })
  const sessionTitle = createMemo(() => sessionInfo()?.title)

  const sessionBadge = createMemo(
    (prev: { workspaceId: string; sessionId: string; badge: { additions: number; deletions: number } } | undefined) => {
      const wsId = routeDirectory()
      const id = sessionId()
      if (!wsId || !id) return undefined
      const summary = routeSession()?.summary
      if (!summary) {
        if (prev?.workspaceId === wsId && prev?.sessionId === id) return prev
        return undefined
      }
      return {
        workspaceId: wsId,
        sessionId: id,
        badge: {
          additions: summary.additions ?? 0,
          deletions: summary.deletions ?? 0,
        },
      }
    },
  )
  const sessionBadgeAdditions = createMemo(() => sessionBadge()?.badge.additions ?? 0)
  const sessionBadgeDeletions = createMemo(() => sessionBadge()?.badge.deletions ?? 0)
  const sessionHasBadge = createMemo(() => !!sessionBadge()?.badge)
  const routeInventorySignature = createMemo(() =>
    [
      `loaded:${sessionInventory().loaded}`,
      `global:${sessionInventory().global.map(sessionTitleSignature).join(",")}`,
      `directory:${routeResolutionDirectories()
        .map((directory) => `${directory}:${directorySessions(directory).map(sessionTitleSignature).join(",")}`)
        .join("|")}`,
      ...Object.entries(sessionInventory().byWorkspace).map(
        ([key, group]) => `${key}:${group.sessions.map(sessionTitleSignature).join(",")}`,
      ),
      ...Object.entries(sessionInventory().byProject).map(
        ([key, sessions]) => `${key}:${sessions.map(sessionTitleSignature).join(",")}`,
      ),
    ].join("|"),
  )

  createEffect(
    () =>
      [
        state.ready(),
        routeDirectory(),
        routeWorkspaceBacking(),
        sessionId(),
        pageId(),
        terminalId(),
        shellRouteKind(),
        location.pathname,
        sessionTitle(),
        sessionHasBadge(),
        sessionBadgeAdditions(),
        sessionBadgeDeletions(),
        routeInventorySignature(),
      ] as const,
    ([ready, wsId, workspaceBacking, id, pid, tid, routeKind, _pathname, title, hasBadge, additions, deletions]) => {
      route.receive({
        ready,
        workspaceId: wsId,
        workspaceBacking,
        sessionId: id,
        marketplace: routeKind === "marketplace",
        workgraph: shellRouteKind() === "workgraph",
        workspaceWorkGraph: shellRouteKind() === "workspaceWorkGraph",
        newTask: shellRouteKind() === "newTask",
        pageId: pid,
        terminalId: tid,
        workspaceBrowse: routeKind === "workspace",
        sessionTitle: title ?? "",
        sessionBadge: hasBadge ? { additions, deletions } : undefined,
      })
    },
  )

  createEffect(
    () =>
      [
        directSessionRouteId(),
        activeSurface()?.sessionId,
        activeSurfaceSessionRefHost(),
        activeSurface()?.directory,
        sessionInventory().loaded,
        routeSessionMetaLookupVersion(),
        sessionInventory()
          .global.map((session) => session.id)
          .join(","),
        Object.entries(sessionInventory().byWorkspace)
          .map(([key, group]) => `${key}:${group.sessions.map((session) => session.id).join(",")}`)
          .join("|"),
        Object.entries(sessionInventory().byProject)
          .map(([key, sessions]) => `${key}:${sessions.map((session) => session.id).join(",")}`)
          .join("|"),
      ] as const,
    ([sessionId]) => {
      if (!sessionId) return
      if (suppressedByFastSessionSwitch(sessionId)) return
      if (isRouteIntentClosed({ sessionId })) return
      const surface = activeSurface()
      const centralRef = routeCentralSessionMeta.get(sessionId)
      if (centralRef) {
        if (
          surface?.type === "session" &&
          surface.sessionId === sessionId &&
          surface.content?.type === "session" &&
          sameSessionRef(surface.content.sessionRef, centralRef)
        )
          return
        state.layout.openCentralSession(sessionId, surface?.content?.title || "Session", {
          authoritative: true,
          sessionRef: centralRef,
        })
        return
      }
      const target = sessionInventoryTarget(sessionId, {
        global: sessionInventory().global,
        byWorkspace: sessionInventory().byWorkspace,
        byProject: sessionInventory().byProject,
        loaded: sessionInventory().loaded,
      })
      const directories = routeResolutionDirectories()
      const cachedTarget = target ? undefined : cachedDirectRouteSessionTarget(sessionId, directories)
      const metaLookupInFlight = cachedTarget ? false : resolveRouteSessionFromMeta(sessionId, directories)
      const matchesActiveWorkspaceSurface =
        !!routeDirectory() &&
        surface?.type === "session" &&
        surface.sessionId === sessionId &&
        surface.directory !== "/workspace" &&
        surface.content?.type === "session" &&
        surface.content.sessionRef?.host === "workspace" &&
        hasBacking(surface.content.sessionRef)
      const matchesActiveSurface =
        matchesActiveWorkspaceSurface ||
        ((surface?.type === "session" || surface?.type === "context") &&
          surface.sessionId === sessionId &&
          (target
            ? surface.directory === target.directory &&
              surface.content?.type === "session" &&
              surface.content.sessionRef?.host === "workspace"
            : !cachedTarget && sessionInventory().loaded && directories.length === 0))
      if (matchesActiveSurface) return
      if (metaLookupInFlight) return
      if (target) {
        void directorySessionCacheActions.ensure({ directory: target.directory })
        state.layout.openSession(target.directory, sessionId, target.title || "Session", {
          sessionRef: target.sessionRef,
        })
        return
      }
      if (cachedTarget) {
        state.layout.openSession(cachedTarget.directory, sessionId, cachedTarget.title || "Session", {
          sessionRef: cachedTarget.sessionRef,
        })
        return
      }
      const resolutionKey = `${sessionId}\0${directories.join("\0")}`
      if (directories.length > 0 && !routeLocalSessionResolutionMisses.has(resolutionKey)) {
        routeLocalSessionResolutionMisses.add(resolutionKey)
      }
      if (!sessionInventory().loaded) return
      const fallbackDirectory = unresolvedRouteWorkspaceTarget(directories)
      if (fallbackDirectory) {
        state.layout.openSession(fallbackDirectory, sessionId, "Session", {
          sessionRef: sessionRefForWorkspaceSession({
            sessionId,
            directory: fallbackDirectory,
          }),
        })
        return
      }
      state.layout.openCentralSession(sessionId, "Session")
    },
  )

  createTrackedEffect(() => {
    routeInventorySignature()
    const focusedId = state.wb.selectors.focusedContent()
    for (const meta of state.meta.all()) {
      if (meta.id === focusedId) continue
      if (meta.type !== "session" && meta.type !== "context") continue
      if (!meta.directory || !meta.sessionId || meta.sessionId === "new") continue
      const title = sessionTitleFromInventory(meta.sessionId, meta.directory, meta.content?.title)
      if (!title || meta.content?.title === title) continue
      state.meta.patch(meta.id, {
        content: {
          ...meta.content,
          type: meta.type,
          directory: meta.directory,
          sessionId: meta.sessionId,
          title,
        },
      })
    }
  })

  return (
    <WorkspaceRouteResolutionProvider resolution={routeResolution}>
      {props.children}
    </WorkspaceRouteResolutionProvider>
  )
}
