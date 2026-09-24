import { createMemo, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ComposerStoreProvider } from "@/composer"
import { useTranslator } from "@/i18n"
import { FirstProjectCanvas, onboardingNeeded } from "@/onboarding"
import { useProjects } from "@/projects"
import { preferenceKey } from "@/lib/persisted"
import { PluginHostProvider } from "@/plugins"
import { useServer, type Capabilities } from "@/server"
import { Toast } from "@/ui"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import { createWorkbenchStore, WorkbenchProvider } from "@/workbench"
import { HomeRedirect } from "../home-redirect"
import { dictionary } from "../i18n"
import { ShellLayoutProvider } from "../layout"
import { CommandsProvider } from "../palette/commands"
import { OpenFileCommand } from "../palette/open-file-command"
import { PlacementProviders } from "../placement-providers"
import { useShellRegistries } from "../registries"
import { useShellRoute } from "../router"
import { sidebarModeOf, type ShellRoute } from "../routes"
import "../shell.css"
import { ShellFrame, type CenterContent } from "./frame"
import { Overlays } from "./overlays"
import { RouteSync } from "./route-sync"
import { SettingsSidebar } from "./settings-sidebar"
import { ShellCommands } from "./shell-commands"

export type AppShellProps = { readonly mainSidebar: JSX.Element; readonly compactTabs: JSX.Element }

export function principalScope(capabilities: Capabilities | undefined): string | undefined {
  if (!capabilities) return undefined
  const principal = capabilities.principal
  return principal.kind === "user" ? `user:${principal.userId}` : `machine:${principal.machineId}`
}

function centerOf(route: ShellRoute): CenterContent {
  return route.kind === "page" && !route.page.tab ? { kind: "page", page: route.page, params: route.params } : { kind: "panes" }
}

function ShellLoading(): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div
      role="status"
      aria-label={t("shell.loading")}
      data-testid="shell-loading"
      class="fixed inset-0 z-[9999] h-dvh w-screen flex flex-col items-center justify-center bg-background-base"
    >
      <ClaxedoSplash class="w-16 h-20 opacity-50" />
    </div>
  )
}

function ScopedShell(props: AppShellProps & { readonly scope: string }): JSX.Element {
  const registries = useShellRegistries()
  const routing = useShellRoute()
  const workbench = createWorkbenchStore(preferenceKey("workbench", props.scope), registries.paneKinds.list)
  const projects = useProjects()
  const firstRun = () => routing.route().kind === "home" && onboardingNeeded(projects())
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
                <OpenFileCommand />
                <Show when={firstRun()} fallback={<ShellBody route={routing.route()} mainSidebar={props.mainSidebar} compactTabs={props.compactTabs} />}>
                  <FirstProjectCanvas />
                </Show>
                <Overlays />
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
  const routing = useShellRoute()
  const scope = createMemo(() => principalScope(server.capabilities()))
  const screen = createMemo(() => {
    const route = routing.route()
    return route.kind === "screen" ? route : undefined
  })
  return (
    <>
      <Show when={screen()} fallback={<Show when={scope()} fallback={<ShellLoading />}>{(s) => <ScopedShell scope={s()} mainSidebar={props.mainSidebar} compactTabs={props.compactTabs} />}</Show>}>
        {(route) => <Dynamic component={route().screen.view} params={route().params} />}
      </Show>
      <Toast.Region />
    </>
  )
}
