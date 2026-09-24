import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { usePickDelivery } from "../pick-to-composer"
import { useBrowserTab } from "../store"
import { ConsoleDrawer } from "./console"
import { PageHost } from "./page-host"
import { PickerShield } from "./picker"
import { Toolbar } from "./toolbar"

export function BrowserTabView(): JSX.Element {
  const t = useTranslator(dictionary)
  const tab = useBrowserTab()
  const deliver = usePickDelivery()
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
        <div data-testid="browser-tab" class="flex h-full min-h-0 w-full flex-col bg-background-base text-text-base">
          <Toolbar tab={current()} deliver={deliver} />
          <div class="relative min-h-0 flex-1">
            <PageHost tab={current()} deliver={deliver} />
            <PickerShield tab={current()} />
          </div>
          <ConsoleDrawer tab={current()} />
        </div>
      )}
    </Show>
  )
}
