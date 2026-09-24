import { createEffect, on, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { usePickDelivery } from "../pick-to-composer"
import { useBrowserTab } from "../store"
import { ConsoleDrawer } from "./console"
import { PageHost } from "./page-host"
import { PickerShield } from "./picker"
import { Toolbar } from "./toolbar"
import { useNoticeToasts } from "./toolbar-actions"

export type BrowserTabViewProps = { readonly url?: string; readonly navigationVersion?: number }

export function BrowserTabView(props: BrowserTabViewProps): JSX.Element {
  const t = useTranslator(dictionary)
  const tab = useBrowserTab()
  const deliver = usePickDelivery()
  useNoticeToasts(tab)
  createEffect(
    on(
      () => [tab(), props.url, props.navigationVersion] as const,
      ([current, url, version]) => {
        if (current && url && version !== undefined) current.navigateOnce(url, version)
      },
    ),
  )
  return (
    <Show
      when={tab()}
      fallback={
        <p class="flex h-full items-center justify-center px-4 text-center text-sm text-text-muted">
          {t("browser.noPlacement")}
        </p>
      }
    >
      {(current) => (
        <div
          class="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background-base"
          data-component="workspace-browser-panel"
          data-testid="workspace-browser-panel"
        >
          <div class="flex h-full w-full flex-col bg-background-base text-text-base">
            <Toolbar tab={current()} />
            <div class="relative flex-1">
              <div data-testid="browser-pane-webview-host" class="absolute inset-0">
                <PageHost tab={current()} deliver={deliver} />
                <PickerShield tab={current()} />
              </div>
            </div>
            <ConsoleDrawer tab={current()} />
          </div>
        </div>
      )}
    </Show>
  )
}
