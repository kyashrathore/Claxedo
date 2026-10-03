import { Match, Show, Switch, type JSX } from "solid-js"
import { WorkspaceArea } from "@/panel"
import { useWorkbench, Workbench } from "@/workbench"
import { useShellLayout } from "../layout"
import type { RouteParams } from "../routes"
import type { PageEntry } from "../types"
import { usePageTabFocused } from "./page-tab"
import { PageView } from "./page-view"
import { Region } from "./region"
import { Sidebar, type SidebarProps } from "./sidebar"
import { SettingsHeader, WorkbenchHeader } from "./workbench-header"
import { useShellRoute } from "../router"
import { LocalSessionRouteNotice } from "./local-session-route-notice"

export type CenterContent = { readonly kind: "page"; readonly page: PageEntry; readonly params: RouteParams } | { readonly kind: "panes" }

export type ShellFrameProps = {
  readonly sidebar: SidebarProps
  readonly center: CenterContent
  readonly compactTabs: JSX.Element
}

function CenterHeader(props: { readonly center: CenterContent; readonly tabs: JSX.Element }): JSX.Element {
  const page = () => (props.center.kind === "page" ? props.center.page : undefined)
  const onPageTab = usePageTabFocused()
  return (
    <Switch fallback={<WorkbenchHeader global={false} tabs={props.tabs} />}>
      <Match when={page()?.sidebar === "settings"}>
        <SettingsHeader />
      </Match>
      <Match when={page() || onPageTab()}>
        <WorkbenchHeader global tabs={props.tabs} />
      </Match>
    </Switch>
  )
}

function PanesRegion(): JSX.Element {
  const layout = useShellLayout()
  const workbench = useWorkbench()
  const routing = useShellRoute()
  const unresolved = () => {
    const state = routing.sessionResolution()
    return state.kind === "loading" || state.kind === "failed" ? state : undefined
  }
  const railHidden = () => (layout.phone() ? !layout.sidebarShown() : !layout.sidebarPinned())
  const closeFocused = (paneId: string, contentId: string | null) => {
    if (railHidden() && contentId) return workbench.closeContent(contentId)
    workbench.split.close(paneId, { destroyContent: false })
  }
  return (
    <Region name="center">
      <Show when={unresolved()} fallback={<Workbench onCloseFocusedPane={closeFocused} />}>
        {(state) => <LocalSessionRouteNotice state={state()} onRetry={routing.retrySessionResolution} />}
      </Show>
    </Region>
  )
}

function CenterRegion(props: { readonly center: CenterContent; readonly tabs: JSX.Element }): JSX.Element {
  return (
    <>
      <CenterHeader center={props.center} tabs={props.tabs} />
      <div class="shell-center-body">
        <Show when={props.center.kind === "page" ? props.center : undefined} fallback={<PanesRegion />}>
          {(page) => <PageView page={page().page} params={page().params} />}
        </Show>
      </div>
    </>
  )
}

export function ShellFrame(props: ShellFrameProps): JSX.Element {
  const layout = useShellLayout()
  return (
    <div class="shell" data-claxedo data-layout={layout.state().kind} data-mac-window-controls={layout.macWindowControls() ? "" : undefined} data-testid="app-shell">
      <div class="shell-body">
        <Sidebar {...props.sidebar} />
        <main
          class="shell-center relative flex flex-1 min-w-0 min-h-0 overflow-hidden bg-background-stronger md:rounded-tl-[12px] transition-[background-color,border-color] duration-200 ease-out"
          data-center={props.center.kind}
          data-testid="shell-center"
        >
          <WorkspaceArea>
            <CenterRegion center={props.center} tabs={props.compactTabs} />
          </WorkspaceArea>
        </main>
      </div>
    </div>
  )
}
