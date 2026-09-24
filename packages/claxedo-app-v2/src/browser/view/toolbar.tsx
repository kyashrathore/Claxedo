import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { IconButton } from "@/ui"
import { dictionary } from "../i18n"
import type { PickDelivery } from "../pick-to-composer"
import type { BrowserTab } from "../tab"
import { AddressBar } from "./address-bar"
import { NoticeRow, ToolbarActions } from "./toolbar-actions"

export function Toolbar(props: { readonly tab: BrowserTab; readonly deliver: PickDelivery }): JSX.Element {
  const t = useTranslator(dictionary)
  const picking = () => props.tab.state().kind === "picking"
  const canPick = () => !!props.tab.bridge && (props.tab.state().kind === "ready" || picking())
  const consoleLabel = () => (props.tab.consoleOpen() ? t("browser.console.hide") : t("browser.console.show"))
  return (
    <div role="toolbar" aria-label={t("browser.tab")} class="flex w-full shrink-0 flex-wrap items-center gap-1 border-b border-border-muted px-2 py-1">
      <IconButton icon="arrow-left" variant="ghost" aria-label={t("browser.back")} disabled={!props.tab.history().canGoBack} onClick={() => void props.tab.act("back")} />
      <IconButton icon="arrow-right" variant="ghost" aria-label={t("browser.forward")} disabled={!props.tab.history().canGoForward} onClick={() => void props.tab.act("forward")} />
      <IconButton icon="reload" variant="ghost" aria-label={t("browser.reload")} disabled={!props.tab.bridge} onClick={() => void props.tab.act("reload")} />
      <AddressBar tab={props.tab} />
      <IconButton
        icon="inspect-element"
        variant="ghost"
        aria-label={picking() ? t("browser.pick.stop") : t("browser.pick")}
        aria-pressed={picking()}
        disabled={!canPick()}
        onClick={() => props.tab.setPicking(!picking())}
      />
      <IconButton
        icon="code"
        variant="ghost"
        aria-label={consoleLabel()}
        aria-pressed={props.tab.consoleOpen()}
        onClick={() => props.tab.setConsoleOpen(!props.tab.consoleOpen())}
      />
      <ToolbarActions tab={props.tab} deliver={props.deliver} />
      <NoticeRow tab={props.tab} />
    </div>
  )
}
