import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { IconButton, Menu } from "@/ui"
import { dictionary } from "../i18n"
import type { PickDelivery } from "../pick-to-composer"
import type { BrowserTab } from "../tab"

async function copyUrl(tab: BrowserTab): Promise<void> {
  const url = tab.state().url
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    tab.notify({ key: "browser.notice.copied" })
  } catch (error) {
    console.error("Browser URL could not be copied", { error })
    tab.notify({ key: "browser.notice.copyFailed" })
  }
}

async function takeScreenshot(tab: BrowserTab, deliver: PickDelivery): Promise<void> {
  const bridge = tab.bridge
  if (!bridge) {
    tab.notify({ key: "browser.notice.desktopOnly" })
    return
  }
  const result = await bridge.captureScreenshot(tab.paneId)
  if (!result.ok) {
    tab.notify(result.error.message ? { text: result.error.message } : { key: "browser.notice.screenshotFailed" })
    return
  }
  const delivered = deliver({ id: uuid(), pageUrl: tab.state().url, selector: "", tagName: "page", comment: "", screenshotDataUrl: result.dataUrl })
  tab.notify({ key: delivered ? "browser.notice.screenshotAdded" : "browser.notice.needSession" })
}

export function ToolbarActions(props: { readonly tab: BrowserTab; readonly deliver: PickDelivery }): JSX.Element {
  const t = useTranslator(dictionary)
  const desktopOnly = () => !props.tab.bridge
  const screenshot = () =>
    takeScreenshot(props.tab, props.deliver).catch((error: unknown) => {
      console.error("Browser screenshot failed", { error })
      props.tab.notify({ key: "browser.notice.screenshotFailed" })
    })
  return (
    <Menu placement="bottom-end">
      <Menu.Trigger as={IconButton} icon="three-dots" variant="ghost" aria-label={t("browser.actions")} />
      <Menu.Portal>
        <Menu.Content>
          <Menu.Item disabled={desktopOnly()} onSelect={() => void screenshot()}>{t("browser.screenshot")}</Menu.Item>
          <Menu.Item disabled={desktopOnly()} onSelect={() => void props.tab.act("devTools")}>{t("browser.devTools")}</Menu.Item>
          <Menu.Item disabled={desktopOnly()} onSelect={() => void props.tab.act("hardReload")}>{t("browser.hardReload")}</Menu.Item>
          <Menu.Item disabled={!props.tab.state().url} onSelect={() => void copyUrl(props.tab)}>{t("browser.copyUrl")}</Menu.Item>
          <Menu.Item disabled={desktopOnly()} onSelect={() => void props.tab.act("clearCookies")}>{t("browser.clearCookies")}</Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}

export function NoticeRow(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const text = () => {
    const notice = props.tab.notice()
    if (!notice) return undefined
    return "key" in notice ? t(notice.key) : notice.text
  }
  return (
    <Show when={text()}>
      {(message) => (
        <div role="status" class="flex w-full items-center gap-2 text-xs text-text-muted">
          <span class="min-w-0 flex-1 truncate">{message()}</span>
          <IconButton icon="close-small" variant="ghost" size="small" aria-label={t("browser.notice.dismiss")} onClick={() => props.tab.notify(undefined)} />
        </div>
      )}
    </Show>
  )
}
