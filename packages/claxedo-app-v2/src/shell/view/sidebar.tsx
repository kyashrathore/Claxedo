import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../store"
import { Region } from "./region"
import { ResizeHandle } from "./resize-handle"

export type SidebarProps = {
  readonly mode: "main" | "settings"
  readonly main: JSX.Element
  readonly settings: JSX.Element
}

export function SidebarContent(props: SidebarProps): JSX.Element {
  return (
    <Region name="sidebar">
      <Show when={props.mode === "settings"} fallback={props.main}>
        {props.settings}
      </Show>
    </Region>
  )
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  return (
    <Show when={layout.sidebarShown()}>
      <nav class="shell-sidebar" aria-label={t("shell.navigation")} data-mode={props.mode} data-testid="sidebar" style={{ width: `${layout.sidebarWidth()}px` }}>
        <SidebarContent mode={props.mode} main={props.main} settings={props.settings} />
      </nav>
      <ResizeHandle
        label={t("shell.sidebarResize")}
        edge="right"
        width={layout.sidebarWidth}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        onResize={layout.setSidebarWidth}
      />
    </Show>
  )
}
