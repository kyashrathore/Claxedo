import { Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useTranslator } from "@/i18n"
import { browserToolbarSlot, ClaxedoIconButton as IconButton, Tooltip } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"
import { AddressBar } from "./address-bar"
import { ToolbarActions } from "./toolbar-actions"

function NavigationButtons(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="flex items-center gap-0.5">
      <Tooltip value={t("browser.back")} placement="bottom">
        <IconButton
          icon="arrow-left"
          variant="ghost"
          size="normal"
          aria-label={t("browser.back")}
          disabled={!props.tab.history().canGoBack}
          onClick={() => void props.tab.act("back")}
          data-testid="browser-pane-back"
        />
      </Tooltip>
      <Tooltip value={t("browser.forward")} placement="bottom">
        <IconButton
          icon="arrow-right"
          variant="ghost"
          size="normal"
          aria-label={t("browser.forward")}
          disabled={!props.tab.history().canGoForward}
          onClick={() => void props.tab.act("forward")}
          data-testid="browser-pane-forward"
        />
      </Tooltip>
      <Tooltip value={t("browser.reload")} placement="bottom">
        <IconButton
          icon="reload"
          variant="ghost"
          size="normal"
          aria-label={t("browser.reload")}
          disabled={!props.tab.bridge}
          onClick={() => void props.tab.act("reload")}
          data-testid="browser-pane-reload"
        />
      </Tooltip>
    </div>
  )
}

function ToolbarRow(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const inspecting = () => props.tab.state().kind === "picking"
  return (
    <div
      class="flex h-9 w-full min-w-0 max-w-full flex-1 self-stretch items-center gap-2 border-b border-border-weak-base bg-background-base px-2 text-12-regular"
      style={{ width: "100%" }}
      data-testid="browser-pane-toolbar"
    >
      <NavigationButtons tab={props.tab} />
      <AddressBar tab={props.tab} />
      <div class="flex items-center gap-0.5">
        <Tooltip value={t("browser.inspect.tooltip")} placement="bottom">
          <IconButton
            icon="inspect-element"
            size="normal"
            variant="ghost"
            aria-label={t("browser.inspect")}
            disabled={!props.tab.bridge}
            aria-pressed={inspecting()}
            class="aria-pressed:bg-surface-base-active"
            onClick={() => props.tab.setPicking(!inspecting())}
            data-testid="browser-pane-inspect-toggle"
          />
        </Tooltip>
        <Show when={props.tab.bridge}>
          <ToolbarActions tab={props.tab} />
        </Show>
      </div>
    </div>
  )
}

export function Toolbar(props: { readonly tab: BrowserTab }): JSX.Element {
  return (
    <Show when={browserToolbarSlot()} fallback={<ToolbarRow tab={props.tab} />}>
      {(host) => (
        <Portal mount={host()}>
          <ToolbarRow tab={props.tab} />
        </Portal>
      )}
    </Show>
  )
}
