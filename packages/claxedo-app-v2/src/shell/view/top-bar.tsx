import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { IconButton } from "@/ui"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"

export function TopBar(props: { readonly center: JSX.Element; readonly showPanelToggle: boolean; readonly showSidebarToggle: boolean }): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  return (
    <div class="shell-topbar" data-testid="shell-topbar">
      <Show when={props.showSidebarToggle}>
        <IconButton
          icon={layout.phone() ? "menu" : "sidebar"}
          variant="ghost"
          aria-label={layout.phone() ? t("shell.menu") : t("shell.sidebarToggle")}
          aria-expanded={layout.sidebarShown()}
          data-testid="sidebar-toggle"
          onClick={() => layout.send({ type: "toggleSidebar" })}
        />
      </Show>
      <div class="shell-topbar-center">{props.center}</div>
      <Show when={props.showPanelToggle}>
        <IconButton
          icon="sidebar-right"
          variant="ghost"
          aria-label={t("shell.panelToggle")}
          aria-expanded={layout.panelShown()}
          data-testid="workspace-panel-toggle"
          onClick={() => layout.send({ type: "togglePanel" })}
        />
      </Show>
    </div>
  )
}
