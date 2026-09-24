import { t } from "../i18n"
import type { BrowserTab } from "../tab"
import { AddressBar } from "./address-bar"
import { ToolbarActions } from "./toolbar-actions"

export const toolbarButtonClass =
  "inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md px-1.5 text-12-regular text-text-base transition-colors hover:bg-surface-base-hover disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-surface-base-active pointer-coarse:h-11 pointer-coarse:min-w-11"

export function Toolbar(props: { readonly tab: BrowserTab }) {
  const picking = () => props.tab.state().kind === "picking"
  const canPick = () => !!props.tab.bridge && (props.tab.state().kind === "ready" || picking())
  const consoleLabel = () => (props.tab.consoleOpen() ? t("browser.console.hide") : t("browser.console.show"))
  return (
    <div
      role="toolbar"
      aria-label={t("browser.tab")}
      class="flex w-full flex-wrap items-center gap-1 border-b border-border-weak-base px-2 py-1"
    >
      <button
        type="button"
        class={toolbarButtonClass}
        aria-label={t("browser.back")}
        title={t("browser.back")}
        disabled={!props.tab.history().canGoBack}
        onClick={() => void props.tab.act("back")}
      >
        ‹
      </button>
      <button
        type="button"
        class={toolbarButtonClass}
        aria-label={t("browser.forward")}
        title={t("browser.forward")}
        disabled={!props.tab.history().canGoForward}
        onClick={() => void props.tab.act("forward")}
      >
        ›
      </button>
      <button
        type="button"
        class={toolbarButtonClass}
        aria-label={t("browser.reload")}
        title={t("browser.reload")}
        disabled={!props.tab.bridge}
        onClick={() => void props.tab.act("reload")}
      >
        ↻
      </button>
      <AddressBar tab={props.tab} />
      <button
        type="button"
        class={toolbarButtonClass}
        aria-label={picking() ? t("browser.pick.stop") : t("browser.pick")}
        title={picking() ? t("browser.pick.stop") : t("browser.pick")}
        aria-pressed={picking()}
        disabled={!canPick()}
        onClick={() => props.tab.setPicking(!picking())}
      >
        {t("browser.pick.short")}
      </button>
      <button
        type="button"
        class={toolbarButtonClass}
        aria-label={consoleLabel()}
        title={consoleLabel()}
        aria-pressed={props.tab.consoleOpen()}
        onClick={() => props.tab.setConsoleOpen(!props.tab.consoleOpen())}
      >
        {t("browser.console")}
      </button>
      <ToolbarActions tab={props.tab} />
    </div>
  )
}
