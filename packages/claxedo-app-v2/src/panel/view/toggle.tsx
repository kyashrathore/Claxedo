import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui"
import { panelDictionary } from "../i18n"
import { usePanel } from "../store"

export function PanelToggleButton(): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  const label = () => (panel.open() ? t("panel.close") : t("panel.open"))
  return (
    <button
      type="button"
      data-testid="workspace-panel-toggle"
      data-icon-interaction="binary"
      class="relative flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors duration-100 hover:bg-surface-base-hover hover:text-icon-base"
      aria-label={label()}
      title={label()}
      aria-pressed={panel.open()}
      onClick={() => panel.toggle()}
    >
      <Icon name={panel.open() ? "layout-right-full" : "layout-right-partial"} size="small" />
    </button>
  )
}

export function PanelToggle(): JSX.Element {
  const panel = usePanel()
  return (
    <Show when={!panel.open()}>
      <div data-testid="workspace-panel-floating-chrome" class="flex items-center gap-0.5">
        <PanelToggleButton />
      </div>
    </Show>
  )
}
