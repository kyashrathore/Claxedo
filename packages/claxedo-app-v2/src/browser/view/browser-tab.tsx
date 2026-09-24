import { Show } from "solid-js"
import { t } from "../i18n"
import { useBrowserTab } from "../store"
import { ConsoleDrawer } from "./console"
import { PageHost } from "./page-host"
import { PickerShield } from "./picker"
import { Toolbar } from "./toolbar"

export function BrowserTabView() {
  const tab = useBrowserTab()
  return (
    <Show
      when={tab()}
      fallback={
        <div class="flex h-full items-center justify-center px-4 text-center text-12-regular text-text-weak">
          {t("browser.noPlacement")}
        </div>
      }
    >
      {(current) => (
        <div data-component="browser-tab" class="flex h-full min-h-0 w-full flex-col bg-background-base text-text-base">
          <Toolbar tab={current()} />
          <div class="relative min-h-0 flex-1">
            <PageHost tab={current()} />
            <PickerShield tab={current()} />
          </div>
          <ConsoleDrawer tab={current()} />
        </div>
      )}
    </Show>
  )
}
