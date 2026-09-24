import { createEffect, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, showToast } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"

const TOAST_MS = 2500

async function copyUrl(tab: BrowserTab): Promise<void> {
  const url = tab.state().url
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    tab.notify({ key: "browser.toast.copied" })
  } catch (error) {
    console.error("Browser URL could not be copied", { error })
    tab.notify({ key: "browser.toast.copyFailed" })
  }
}

async function takeScreenshot(tab: BrowserTab): Promise<void> {
  const bridge = tab.bridge
  if (!bridge) return
  const result = await bridge.captureScreenshot(tab.paneId)
  tab.notify(
    result.ok
      ? { key: "browser.toast.screenshot" }
      : { key: "browser.toast.screenshotFailed", params: { code: result.error.code } },
  )
}

export function useNoticeToasts(tab: () => BrowserTab | undefined): void {
  const t = useTranslator(dictionary)
  createEffect(() => {
    const current = tab()
    const notice = current?.notice()
    if (!current || !notice) return
    showToast({ title: "key" in notice ? t(notice.key, notice.params) : notice.text, duration: TOAST_MS })
    current.notify(undefined)
  })
}

export function ToolbarActions(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const screenshot = () =>
    takeScreenshot(props.tab).catch((error: unknown) => {
      console.error("Browser screenshot failed", { error })
      props.tab.notify({ key: "browser.toast.actionFailed" })
    })
  return (
    <DropdownMenu gutter={4} placement="bottom-end">
      <Tooltip value={t("browser.options")} placement="bottom">
        <DropdownMenu.Trigger
          class="flex size-6 items-center justify-center rounded-sm text-icon-base transition-colors hover:bg-surface-base-hover aria-expanded:bg-surface-base-active"
          aria-label={t("browser.options")}
          data-testid="browser-pane-menu-trigger"
        >
          <Icon name="three-dots" size="small" class="rotate-90" />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content data-testid="browser-pane-menu">
          <DropdownMenu.Item onSelect={() => void screenshot()} data-testid="browser-pane-menu-screenshot">
            <Icon name="photo" size="small" />
            {t("browser.screenshot")}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void props.tab.act("devTools")} data-testid="browser-pane-menu-devtools">
            <Icon name="code" size="small" />
            {t("browser.devTools")}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => void props.tab.act("hardReload")}
            data-testid="browser-pane-menu-hard-reload"
          >
            <Icon name="reset" size="small" />
            {t("browser.hardReload")}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void copyUrl(props.tab)} data-testid="browser-pane-menu-copy-url">
            <Icon name="copy" size="small" />
            {t("browser.copyUrl")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            onSelect={() => void props.tab.act("clearCookies")}
            data-testid="browser-pane-menu-clear-cookies"
          >
            <Icon name="trash" size="small" />
            {t("browser.clearCookies")}
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem
            checked={props.tab.consoleOpen()}
            onChange={(open: boolean) => props.tab.setConsoleOpen(open)}
            closeOnSelect={false}
            data-testid="browser-pane-menu-console"
          >
            <span class="flex-1">{t("browser.console.show")}</span>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
