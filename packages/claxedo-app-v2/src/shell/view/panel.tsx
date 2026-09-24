import { createMemo, For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { byOrder } from "../registries"
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../store"
import type { PanelTab } from "../types"
import { RegistryIcon } from "./icon"
import { Region } from "./region"
import { ResizeHandle } from "./resize-handle"

export type PanelProps = { readonly tabs: readonly PanelTab[]; readonly scope: string }

export function PanelContent(props: PanelProps): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  const tabs = createMemo(() => byOrder(props.tabs.filter((tab) => !tab.when || tab.when())))
  const active = createMemo(() => {
    const preferred = layout.panel(props.scope).tab
    return tabs().find((tab) => tab.id === preferred) ?? tabs()[0]
  })
  return (
    <div class="shell-panel-content">
      <div role="tablist" aria-label={t("shell.panelTabs")} class="shell-panel-tabs">
        <For each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              id={`panel-tab-${tab.id}`}
              aria-selected={active()?.id === tab.id}
              aria-controls={`panel-tabpanel-${tab.id}`}
              tabindex={active()?.id === tab.id ? 0 : -1}
              class="shell-panel-tab"
              onClick={() => layout.setPanelTab(props.scope, tab.id)}
            >
              <RegistryIcon name={tab.icon} />
              <span>{tab.title()}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={active()} fallback={<div class="shell-panel-empty">{t("shell.panelEmpty")}</div>}>
        {(tab) => (
          <div role="tabpanel" id={`panel-tabpanel-${tab().id}`} aria-labelledby={`panel-tab-${tab().id}`} class="shell-panel-body">
            <Region name="panel">
              <Dynamic component={tab().view} />
            </Region>
          </div>
        )}
      </Show>
    </div>
  )
}

export function Panel(props: PanelProps): JSX.Element {
  const t = useTranslator(dictionary)
  const layout = useShellLayout()
  const width = () => layout.panel(props.scope).width
  return (
    <Show when={layout.panelShown()}>
      <ResizeHandle label={t("shell.panelResize")} edge="left" width={width} min={PANEL_MIN_WIDTH} max={PANEL_MAX_WIDTH} onResize={(next) => layout.setPanelWidth(props.scope, next)} />
      <aside class="shell-panel" aria-label={t("shell.panel")} data-testid="workspace-panel" style={{ width: `${width()}px` }}>
        <PanelContent tabs={props.tabs} scope={props.scope} />
      </aside>
    </Show>
  )
}
