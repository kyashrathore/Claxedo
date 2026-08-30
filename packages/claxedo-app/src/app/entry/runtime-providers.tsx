import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { createEffect, createSignal, type Component, type ParentProps } from "solid-js"
import { GlobalSyncProvider } from "@/app/providers/global-sync/provider"
import { PermissionProvider } from "@/features/session/providers/permission"
import { LayoutProvider } from "@/app/providers/layout"
import { GlobalSDKProvider } from "@/app/providers/global-sdk/provider"
import { SettingsProvider } from "@/platform/settings/provider"
import { NotificationProvider } from "@/app/providers/notification"
import { ModelsProvider } from "@/features/session/providers/models"
import { CommandProvider } from "@/app/providers/command"
import { HighlightsProvider } from "@/features/review/providers/highlights"
import { SessionTitleProjectionProvider } from "@/features/session/providers/session-title-projection-provider"
import { installConversationPrincipalIsolation } from "@/features/session/conversation/conversation-registry"
import { usePrincipal } from "@/platform/auth/identity-provider"

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
  installConversationPrincipalIsolation({ principal: usePrincipal() })
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
      <SessionTitleProjectionProvider>
        <GlobalSyncProvider>
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
        </GlobalSyncProvider>
      </SessionTitleProjectionProvider>
    </GlobalSDKProvider>
  )
  trace("runtime.providersMounted", performance.now() - started)
  return providers
}

function trace(name: string, durationMs: number) {
  markRendererPhase(name, durationMs)
}
