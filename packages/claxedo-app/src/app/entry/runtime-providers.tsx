import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { createEffect, createSignal, onCleanup, onMount, type Component, type ParentProps } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { installUsageOutboxWakeups } from "@/features/usage/data/usage-api"
import { GlobalSyncProvider } from "@/app/providers/global-sync/provider"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { LocalWorkspaceAutoShareProvider } from "@/features/workspaces/data/auto-share-local-workspaces"
import { PermissionProvider } from "@/features/session/providers/permission"
import { LayoutProvider } from "@/app/providers/layout"
import { GlobalSDKProvider } from "@/app/providers/global-sdk/provider"
import { SettingsProvider } from "@/platform/settings/provider"
import { NotificationProvider } from "@/app/providers/notification"
import { ModelsProvider } from "@/features/session/providers/models"
import { CommandProvider } from "@/app/providers/command"
import { HighlightsProvider } from "@/features/review/providers/highlights"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import { installPrincipalDataIsolation } from "@/app/integrations/sync/global-sync-boundary"
import { principalDataScope, usePrincipal } from "@/platform/auth/identity-provider"
import { flushQueryPersistence, installQueryPersister } from "@/platform/query/persister"
import { fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"

trace("runtime.providersModuleEvaluated", 0)

type ClaxedoAppShellComponent = Component<ParentProps>
const [claxedoAppShell, setClaxedoAppShell] = createSignal<ClaxedoAppShellComponent>()
let claxedoAppShellLoad: Promise<ClaxedoAppShellComponent> | undefined

export function preloadRuntimeProviders() {
  const started = performance.now()
  claxedoAppShellLoad ??= (() => {
    // Start both requests together. They remain separate dynamic module graphs,
    // so evaluation can yield between them without paying a serial fetch.
    const secondaryStarted = performance.now()
    const secondaryReady = import("@/app/integrations/secondary-feature-ports").then(() => {
      trace("runtime.secondaryFeaturePortsReady", performance.now() - secondaryStarted)
    })

    return import("@/app/integrations/feature-ports")
      .then(() => {
        trace("runtime.featurePortsReady", performance.now() - started)
        return secondaryReady
      })
      .then(() => {
        const shellStarted = performance.now()
        return import("@/app/app-shell-bootstrap").then((module) => {
          trace("runtime.appShellReady", performance.now() - shellStarted)
          return module
        })
      })
      .then((module) => {
        setClaxedoAppShell(() => module.ClaxedoAppShell)
        return module.ClaxedoAppShell
      })
  })()
  return claxedoAppShellLoad
}

export function RuntimeProviders(props: ParentProps) {
  const started = performance.now()
  const AppShell = claxedoAppShell()
  const principal = usePrincipal()
  installQueryPersister({
    quietDelay: fastSessionSwitchAnyQuietDelay,
    scope: () => principalDataScope(principal()),
  })
  installPrincipalDataIsolation({ principal })
  // No UI reads its result, so this no longer waits for the app shell chunk
  // (previously mounted from inside `ClaxedoAppShellContent`, gated behind
  // the lazy app-shell-bootstrap import above): it starts as soon as the
  // provider tree itself mounts, alongside the rest of wave 1.
  onMount(() => onCleanup(installUsageOutboxWakeups()))
  let didSignalPaint = false

  createEffect(() => {
    if (!AppShell || didSignalPaint) return
    didSignalPaint = true
    requestAnimationFrame(() => {
      trace("runtime.firstPaint", performance.now() - started)
    })
  })

  const providers = (
    <GlobalSDKProvider>
      <SessionTitleProjectionProvider scope={() => principalDataScope(principal())}>
        <GlobalSyncProvider flushNavigationPersistence={flushQueryPersistence}>
          <LocalWorkspaceAutoShare>
            <SettingsProvider>
              <PermissionProvider>
                <LayoutProvider>
                  <NotificationProvider>
                    <ModelsProvider>
                      <CommandProvider>
                        <HighlightsProvider>{AppShell ? <AppShell>{props.children}</AppShell> : null}</HighlightsProvider>
                      </CommandProvider>
                    </ModelsProvider>
                  </NotificationProvider>
                </LayoutProvider>
              </PermissionProvider>
            </SettingsProvider>
          </LocalWorkspaceAutoShare>
        </GlobalSyncProvider>
      </SessionTitleProjectionProvider>
    </GlobalSDKProvider>
  )
  trace("runtime.providersMounted", performance.now() - started)
  return providers
}

/**
 * Machine-level remote access, watching for the whole session.
 *
 * "A workspace you open shares itself" is only true while something is
 * reconciling, so this is the app shell's own mount rather than a surface's:
 * it runs from boot to teardown, and every panel below reads its result through
 * `useLocalWorkspaceAutoShareStatus()`. Wrapping rather than sitting beside the
 * other providers is what makes that reachable — and what makes a surface
 * physically unable to start a second reconciler.
 *
 * It sits HERE and not beside `RemoteAccessMarkerRecorder` in `app.tsx` for a
 * provider-ordering reason, not a taste one: the project inventory comes from
 * `useShellQueryOptions()`, which reads `GlobalSyncProvider` — and that
 * provider is mounted below `AuthenticatedProviders`, where the marker
 * recorder lives. This is the highest point in the tree where the inventory
 * exists at all.
 */
function LocalWorkspaceAutoShare(props: ParentProps) {
  const shellQueries = useShellQueryOptions()
  const projects = useQuery(() => shellQueries.projects())
  return (
    <LocalWorkspaceAutoShareProvider projects={() => projects.data}>
      {props.children}
    </LocalWorkspaceAutoShareProvider>
  )
}

function trace(name: string, durationMs: number) {
  markRendererPhase(name, durationMs)
}
