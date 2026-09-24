import { createEffect, on, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { usePickDelivery } from "../pick-to-composer"
import { useBrowserTab } from "../store"
import { ConsoleDrawer } from "./console"
import { PageHost } from "./page-host"
import { PickerShield } from "./picker"
import { Toolbar } from "./toolbar"

export type BrowserTabViewProps = { readonly url?: string; readonly navigationVersion?: number }

export function BrowserTabView(props: BrowserTabViewProps): JSX.Element {
  const t = useTranslator(dictionary)
  const tab = useBrowserTab()
  const deliver = usePickDelivery()
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
