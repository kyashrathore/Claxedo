import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { PanelToggle } from "@/panel"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { shellDictionary } from "../i18n"
import { useShellLayout } from "../layout"
import { ScopeButtons } from "./scope-buttons"
import { ClaxedoIcon as Icon } from "@/ui"

export function TitlebarDragRegion(props: { readonly class?: string }): JSX.Element {
  return <div data-window-drag-region data-testid="titlebar-drag-region" aria-hidden="true" class={`self-stretch ${props.class ?? ""}`} />
}

export function ShowSidebarButton(props: { readonly peek: boolean }): JSX.Element {
  const t = useTranslator(shellDictionary)
  const layout = useShellLayout()
  return (
    <Tooltip value={t("shell.showSidebar")}>
      <button
        type="button"
        aria-label={t("shell.showSidebar")}
        aria-pressed="false"
        data-icon-interaction="binary"
        class="relative z-[90] hidden size-6 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base md:flex"
        onMouseEnter={(event) => {
          const from = event.relatedTarget
          if (!props.peek || layout.peekMuted() || (from instanceof Element && from.closest('[data-testid="rail-sidebar"]'))) return
          layout.send({ type: "peekSidebar" })
        }}
        onClick={() => layout.send({ type: "showSidebar" })}
      >
        <Icon name="layout-left-partial" size="small" />
      </button>
    </Tooltip>
  )
}

export function WorkbenchHeader(props: { readonly global: boolean; readonly tabs?: JSX.Element }): JSX.Element {
  const layout = useShellLayout()
  const toggleShown = () => !props.global
  return (
    <div
      data-testid="workbench-shell-header"
      data-surface="header"
      data-window-drag-region
      class="relative flex h-9 shrink-0 items-center gap-1 overflow-hidden border-b border-border-weaker-base bg-background-base"
      classList={{
        "pr-10": toggleShown() && !layout.panelShown(),
        "pr-1": !toggleShown() || layout.panelShown(),
      }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1 px-1">
        <Show when={!layout.sidebarPinned()}>
          <ShowSidebarButton peek />
          <TitlebarDragRegion class="w-4 shrink-0" />
          {props.tabs}
          <TitlebarDragRegion class="min-w-8 flex-1" />
        </Show>
      </div>
      <div data-testid="workbench-header-controls" class="flex shrink-0 items-center gap-1">
        <ScopeButtons />
        <Show when={toggleShown()}>
          <div class="absolute inset-y-0 right-1 z-40 flex items-center gap-0.5">
            <PanelToggle />
          </div>
        </Show>
      </div>
    </div>
  )
}

export function SettingsHeader(): JSX.Element {
  const t = useTranslator(shellDictionary)
  const layout = useShellLayout()
  return (
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border-weaker-base pr-1">
      <div class="flex min-w-0 flex-1 items-center gap-1 px-1">
        <Show when={!layout.sidebarPinned()}>
          <ShowSidebarButton peek={false} />
          <span class="flex min-w-0 items-center gap-1.5 rounded-md bg-surface-base px-2.5 py-1 text-compact text-text-strong">
            <Icon name="sliders" size="small" />
            <span class="truncate">{t("shell.settings")}</span>
          </span>
        </Show>
      </div>
    </div>
  )
}
