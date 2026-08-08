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

type ClaxedoAppShellComponent = Component<ParentProps>
const [claxedoAppShell, setClaxedoAppShell] = createSignal<ClaxedoAppShellComponent>()
let claxedoAppShellLoad: Promise<ClaxedoAppShellComponent> | undefined

export function preloadRuntimeProviders() {
  const started = performance.now()
  claxedoAppShellLoad ??= import("@/app/integrations/feature-ports")
    .then(() => {
      trace("runtime.featurePortsReady", performance.now() - started)
      const shellStarted = performance.now()
      return import("@/app/app-shell").then((module) => {
        trace("runtime.appShellReady", performance.now() - shellStarted)
        return module
      })
    })
    .then((module) => {
      setClaxedoAppShell(() => module.ClaxedoAppShell)
      return module.ClaxedoAppShell
    })
  return claxedoAppShellLoad
}

export function RuntimeProviders(props: ParentProps & { onPainted: () => void }) {
  const started = performance.now()
  const AppShell = claxedoAppShell()
  let didSignalPaint = false

  createEffect(() => {
    if (!AppShell || didSignalPaint) return
    didSignalPaint = true
    requestAnimationFrame(() => {
      trace("runtime.firstPaint", performance.now() - started)
      props.onPainted()
    })
  })

  const providers = (
    <GlobalSDKProvider>
      <GlobalSyncProvider>
        <SettingsProvider>
          <PermissionProvider>
            <LayoutProvider>
              <NotificationProvider>
                <ModelsProvider>
                  <CommandProvider>
                    <HighlightsProvider>
                      {AppShell ? <AppShell>{props.children}</AppShell> : null}
                    </HighlightsProvider>
                  </CommandProvider>
                </ModelsProvider>
              </NotificationProvider>
            </LayoutProvider>
          </PermissionProvider>
        </SettingsProvider>
      </GlobalSyncProvider>
    </GlobalSDKProvider>
  )
  trace("runtime.providersMounted", performance.now() - started)
  return providers
}

function trace(name: string, durationMs: number) {
  const target = window as unknown as {
    __claxedoPerfTrace?: boolean
    __claxedoPerfRendererPhases?: Array<{ name: string; durationMs: number }>
  }
  if (!target.__claxedoPerfTrace) return
  target.__claxedoPerfRendererPhases?.push({ name, durationMs })
}
