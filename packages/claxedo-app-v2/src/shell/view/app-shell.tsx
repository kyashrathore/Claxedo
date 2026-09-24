import { createMemo, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { preferenceKey } from "@/lib/persisted"
import { useServer, type Capabilities } from "@/server"
import { Toast } from "@/ui"
import { createWorkbenchStore, WorkbenchProvider, useWorkbench } from "@/workbench"
import { dictionary } from "../i18n"
import { ShellLayoutProvider } from "../layout"
import { CommandsProvider } from "../palette/commands"
import { CommandPalette } from "../palette/palette"
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
import { ThemeBridge } from "./theme-bridge"

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
    <WorkbenchProvider store={workbench}>
      <ShellLayoutProvider scope={props.scope}>
        <CommandsProvider>
          <RouteSync />
          <ShellCommands />
          <ThemeBridge />
          <ConnectionBanner />
          <ShellBody route={routing.route()} mainSidebar={props.mainSidebar} />
          <CommandPalette />
          <Overlays />
        </CommandsProvider>
      </ShellLayoutProvider>
    </WorkbenchProvider>
  )
}

function ShellBody(props: { readonly route: ShellRoute; readonly mainSidebar: JSX.Element }): JSX.Element {
  const registries = useShellRegistries()
  const workbench = useWorkbench()
  const panelScope = createMemo(() => {
    const focused = workbench.selectors.focusedContent()
    const route = focused ? workbench.routeOf(focused) : undefined
    return route?.kind === "session" ? route.projectId : "default"
  })
  const phoneHome = () => props.route.kind === "home" && workbench.selectors.focusedContent() === null
  return (
    <ShellFrame
      sidebar={{ mode: sidebarModeOf(props.route), main: props.mainSidebar, settings: <SettingsSidebar /> }}
      center={centerOf(props.route)}
      panel={{ tabs: registries.panelTabs.list(), scope: panelScope() }}
      phoneHome={phoneHome()}
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
