import { Show, createSignal } from "solid-js"
import { t } from "../i18n"
import type { BrowserTab } from "../tab"
import { toolbarButtonClass } from "./toolbar"

async function copyUrl(tab: BrowserTab) {
  const url = tab.state().url
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
  } catch {
    tab.notify(t("browser.notice.copyFailed"))
    return
  }
  tab.notify(t("browser.notice.copied"))
}

async function takeScreenshot(tab: BrowserTab) {
  const bridge = tab.bridge
  if (!bridge) {
    tab.notify(t("browser.notice.desktopOnly"))
    return
  }
  const result = await bridge.captureScreenshot(tab.paneId)
  if (!result.ok) {
    tab.notify(result.error.message ?? `${t("browser.notice.screenshotFailed")} (${result.error.code})`)
    return
  }
  tab.addPick({
    id: crypto.randomUUID(),
    pageUrl: tab.state().url,
    selector: "",
    tagName: "page",
    comment: "",
    screenshotDataUrl: result.dataUrl,
  })
  tab.notify(t("browser.notice.screenshotAdded"))
}

export function ToolbarActions(props: { readonly tab: BrowserTab }) {
  const [open, setOpen] = createSignal(false)
  const desktopOnly = () => !props.tab.bridge
  return (
    <>
      <button
        type="button"
        class={toolbarButtonClass}
        aria-label={t("browser.actions")}
        title={t("browser.actions")}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        …
      </button>
      <Show when={open()}>
        <div class="flex w-full flex-wrap items-center gap-1">
          <button type="button" class={toolbarButtonClass} disabled={desktopOnly()} onClick={() => void takeScreenshot(props.tab)}>
            {t("browser.screenshot")}
          </button>
          <button type="button" class={toolbarButtonClass} disabled={desktopOnly()} onClick={() => void props.tab.act("devTools")}>
            {t("browser.devTools")}
          </button>
          <button type="button" class={toolbarButtonClass} disabled={desktopOnly()} onClick={() => void props.tab.act("hardReload")}>
            {t("browser.hardReload")}
          </button>
          <button type="button" class={toolbarButtonClass} disabled={!props.tab.state().url} onClick={() => void copyUrl(props.tab)}>
            {t("browser.copyUrl")}
          </button>
          <button type="button" class={toolbarButtonClass} disabled={desktopOnly()} onClick={() => void props.tab.act("clearCookies")}>
            {t("browser.clearCookies")}
          </button>
        </div>
      </Show>
      <Show when={props.tab.notice()}>
        {(message) => (
          <div role="status" class="flex w-full items-center gap-2 text-12-regular text-text-weak">
            <span class="min-w-0 flex-1 truncate">{message()}</span>
            <button
              type="button"
              class={toolbarButtonClass}
              aria-label={t("browser.notice.dismiss")}
              title={t("browser.notice.dismiss")}
              onClick={() => props.tab.notify(undefined)}
            >
              ×
            </button>
          </div>
        )}
      </Show>
    </>
  )
}
