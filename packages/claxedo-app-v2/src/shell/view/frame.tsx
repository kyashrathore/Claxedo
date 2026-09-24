import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Workbench, WorkbenchPaneSwitcher, WorkbenchTabs } from "@/workbench"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import type { RouteParams } from "../routes"
import type { PageEntry, PanelTab } from "../types"
import { PhoneDrawer } from "./drawer"
import { PageHeader, PageTab } from "./page-tab"
import { Panel, PanelContent } from "./panel"
import { Region } from "./region"
import { Sidebar, SidebarContent, type SidebarProps } from "./sidebar"
import { TopBar } from "./top-bar"

export type CenterContent = { readonly kind: "page"; readonly page: PageEntry; readonly params: RouteParams } | { readonly kind: "panes" }

export type ShellFrameProps = {
  readonly sidebar: SidebarProps
  readonly center: CenterContent
  readonly panel: { readonly tabs: readonly PanelTab[]; readonly scope: string }
  readonly phoneHome: boolean
}

function CenterRegion(props: { readonly center: CenterContent }): JSX.Element {
  const layout = useShellLayout()
  const header = () => {
    if (props.center.kind === "page") return <PageHeader page={props.center.page} />
    return layout.phone() ? <WorkbenchPaneSwitcher /> : <WorkbenchTabs />
  }
  return (
    <>
      <TopBar center={header()} showSidebarToggle showPanelToggle={props.center.kind === "panes"} />
      <div class="shell-center-body">
        <Show when={props.center.kind === "page" ? props.center : undefined} fallback={<Region name="center"><Workbench /></Region>}>
          {(page) => <PageTab page={page().page} params={page().params} />}
        </Show>
      </div>
    </>
  )
}

export function ShellFrame(props: ShellFrameProps): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  return (
    <div class="shell" data-phone={layout.phone() ? "true" : undefined} data-layout={layout.state().kind} data-testid="app-shell">
      <div class="shell-body">
        <Show when={!layout.phone()}>
          <Sidebar {...props.sidebar} />
        </Show>
        <main class="shell-center" data-center={props.center.kind} data-testid="shell-center">
          <Show when={!(layout.phone() && props.phoneHome)} fallback={<PhoneHome sidebar={props.sidebar} />}>
            <CenterRegion center={props.center} />
          </Show>
        </main>
        <Show when={!layout.phone()}>
          <Panel tabs={props.panel.tabs} scope={props.panel.scope} />
        </Show>
      </div>
      <Show when={layout.phone()}>
        <PhoneDrawer open={layout.sidebarShown()} onClose={() => layout.send({ type: "hideSidebar" })} side="left" label={t("shell.sidebar")} testId="sidebar-drawer">
          <SidebarContent {...props.sidebar} />
        </PhoneDrawer>
        <PhoneDrawer open={layout.panelShown()} onClose={() => layout.send({ type: "hidePanel" })} side="bottom" label={t("shell.panel")} testId="panel-sheet">
          <PanelContent tabs={props.panel.tabs} scope={props.panel.scope} />
        </PhoneDrawer>
      </Show>
    </div>
  )
}

function PhoneHome(props: { readonly sidebar: SidebarProps }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <>
      <TopBar center={<h1 class="shell-topbar-title">{t("shell.home")}</h1>} showSidebarToggle={false} showPanelToggle={false} />
      <div class="shell-center-body shell-phone-home" data-testid="phone-home">
        <SidebarContent {...props.sidebar} />
      </div>
    </>
  )
}
