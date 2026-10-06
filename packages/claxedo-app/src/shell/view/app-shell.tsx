import { createEffect, createMemo, Show, type JSX } from "solid-js"
import { useAuth } from "@/auth"
import { Dynamic } from "solid-js/web"
import { ComposerStoreProvider } from "@/composer"
import { preferenceKey } from "@/lib/persisted"
import { PluginHostProvider } from "@/plugins"
import { useServer } from "@/server"
import { Toast } from "@/ui"
import { createWorkbenchStore, WorkbenchProvider } from "@/workbench"
import { ForgetGonePlacements } from "../gone-placements"
import { HomeRedirect } from "../home-redirect"
import { principalScope } from "../principal-scope"
import { signInGate } from "../sign-in-gate"
import { ShellLayoutProvider } from "../layout"
import { CommandsProvider } from "../palette/commands"
import { OpenFileCommand } from "../palette/open-file-command"
import { PlacementProviders } from "../placement-providers"
import { useShellRegistries } from "../registries"
import { useShellRoute } from "../router"
import { sidebarModeOf, type ShellRoute } from "../routes"
import "../shell.css"
import { DaemonLostBanner } from "./daemon-lost-banner"
import { ShellFrame, type CenterContent } from "./frame"
import { RegisteredAppearance } from "./registered-appearance"
import { Overlays } from "./overlays"
import { RouteSync } from "./route-sync"
import { SettingsSidebar } from "./settings-sidebar"
import { ShellCommands } from "./shell-commands"
import { ShellStartup } from "./startup"

const LOGIN_PATH = "/login"

export type AppShellProps = { readonly mainSidebar: JSX.Element; readonly compactTabs: JSX.Element }

function centerOf(route: ShellRoute): CenterContent {
  return route.kind === "page" && !route.page.tab ? { kind: "page", page: route.page, params: route.params } : { kind: "panes" }
}

function ScopedShell(props: AppShellProps & { readonly scope: string }): JSX.Element {
  const registries = useShellRegistries()
  const routing = useShellRoute()
  const workbench = createWorkbenchStore(preferenceKey("workbench", props.scope), registries.paneKinds.list)
  return (
    <ComposerStoreProvider scope={props.scope}>
      <WorkbenchProvider store={workbench}>
        <ShellLayoutProvider scope={props.scope}>
          <CommandsProvider>
            <PlacementProviders>
              <PluginHostProvider scope={props.scope}>
                <RegisteredAppearance>
                  <ForgetGonePlacements />
                  <HomeRedirect />
                  <RouteSync />
                  <ShellCommands />
                  <OpenFileCommand />
                  <ShellBody route={routing.route()} mainSidebar={props.mainSidebar} compactTabs={props.compactTabs} />
                  <Overlays />
                </RegisteredAppearance>
              </PluginHostProvider>
            </PlacementProviders>
          </CommandsProvider>
        </ShellLayoutProvider>
      </WorkbenchProvider>
    </ComposerStoreProvider>
  )
}

function ShellBody(props: AppShellProps & { readonly route: ShellRoute }): JSX.Element {
  const main = props.mainSidebar
  const settings = <SettingsSidebar />
  return (
    <ShellFrame
      sidebar={{ mode: sidebarModeOf(props.route), main, settings }}
      center={centerOf(props.route)}
      compactTabs={props.compactTabs}
    />
  )
}

export function AppShell(props: AppShellProps): JSX.Element {
  const server = useServer()
  const auth = useAuth()
  const routing = useShellRoute()
  const gate = createMemo(() => signInGate(auth.state(), server.capabilities()))
  const scope = createMemo(() => (gate() === "open" ? principalScope(auth.state(), server.capabilities()) : undefined))
  const screen = createMemo(() => {
    const route = routing.route()
    return route.kind === "screen" && (!route.screen.requiresSignIn || gate() === "open") ? route : undefined
  })
  createEffect(() => {
    if (gate() === "login" && !screen()) routing.navigate(LOGIN_PATH, { replace: true })
  })
  return (
    <>
      <Show when={screen()} fallback={<Show when={scope()} keyed fallback={<ShellStartup />}>{(s) => <ScopedShell scope={s} mainSidebar={props.mainSidebar} compactTabs={props.compactTabs} />}</Show>}>
        {(route) => <Dynamic component={route().screen.view} params={route().params} />}
      </Show>
      <Toast.Region />
      <DaemonLostBanner />
    </>
  )
}
