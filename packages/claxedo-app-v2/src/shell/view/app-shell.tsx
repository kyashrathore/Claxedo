import { createMemo, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ComposerStoreProvider } from "@/composer"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { preferenceKey } from "@/lib/persisted"
import { PluginHostProvider } from "@/plugins"
import { useServer, type Capabilities } from "@/server"
import { Toast } from "@/ui"
import { createWorkbenchStore, WorkbenchProvider } from "@/workbench"
import { HomeRedirect } from "../home-redirect"
import { dictionary } from "../i18n"
import { ShellLayoutProvider } from "../layout"
import { CommandsProvider } from "../palette/commands"
import { CommandPalette } from "../palette/palette"
import { PlacementProviders } from "../placement-providers"
import { useShellRegistries } from "../registries"
import { useShellRoute } from "../router"
import { sidebarModeOf, type ShellRoute } from "../routes"
import "../shell.css"
import { ConnectionBanner } from "./connection-banner"
import { ShellFrame, type CenterContent } from "./frame"
import { Overlays } from "./overlays"
import { RouteSync } from "./route-sync"
import { SettingsSidebar } from "./settings-sidebar"
import { ShellCommands } from "./shell-commands"

export type AppShellProps = { readonly mainSidebar: JSX.Element }

export function principalScope(capabilities: Capabilities | undefined): string | undefined {
  if (!capabilities) return undefined
  const principal = capabilities.principal
  return principal.kind === "user" ? `user:${principal.userId}` : `machine:${principal.machineId}`
}

function centerOf(route: ShellRoute): CenterContent {
  return route.kind === "page" ? { kind: "page", page: route.page, params: route.params } : { kind: "panes" }
}

function ShellLoading(): JSX.Element {
  const t = useTranslator(dictionary)
  const elapsed = useElapsed()
  return (
    <div class="shell-loading" data-testid="shell-loading">
      <Show when={elapsed()}>
        <span role="status">{t("shell.loading")}</span>
      </Show>
    </div>
  )
}

function ScopedShell(props: { readonly scope: string; readonly mainSidebar: JSX.Element }): JSX.Element {
  const registries = useShellRegistries()
  const routing = useShellRoute()
  const workbench = createWorkbenchStore(preferenceKey("workbench", props.scope), registries.paneKinds.list)
  return (
    <ComposerStoreProvider>
      <WorkbenchProvider store={workbench}>
        <ShellLayoutProvider scope={props.scope}>
          <CommandsProvider>
            <PlacementProviders>
              <PluginHostProvider scope={props.scope}>
                <HomeRedirect />
                <RouteSync />
                <ShellCommands />
                  <ConnectionBanner />
                <ShellBody route={routing.route()} mainSidebar={props.mainSidebar} />
                <CommandPalette />
                <Overlays />
              </PluginHostProvider>
            </PlacementProviders>
          </CommandsProvider>
        </ShellLayoutProvider>
      </WorkbenchProvider>
    </ComposerStoreProvider>
  )
}

function ShellBody(props: { readonly route: ShellRoute; readonly mainSidebar: JSX.Element }): JSX.Element {
  return (
    <ShellFrame
      sidebar={{ mode: sidebarModeOf(props.route), main: props.mainSidebar, settings: <SettingsSidebar /> }}
      center={centerOf(props.route)}
    />
  )
}

export function AppShell(props: AppShellProps): JSX.Element {
  const server = useServer()
  const routing = useShellRoute()
  const scope = createMemo(() => principalScope(server.capabilities()))
  const screen = createMemo(() => {
    const route = routing.route()
    return route.kind === "screen" ? route : undefined
  })
  return (
    <>
      <Show when={screen()} fallback={<Show when={scope()} fallback={<ShellLoading />}>{(s) => <ScopedShell scope={s()} mainSidebar={props.mainSidebar} />}</Show>}>
        {(route) => <Dynamic component={route().screen.view} params={route().params} />}
      </Show>
      <Toast.Region />
    </>
  )
}
