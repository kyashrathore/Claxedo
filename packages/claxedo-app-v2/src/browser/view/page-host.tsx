import { Show, onCleanup, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { BrowserBridge, BrowserWebview } from "../bridge"
import { dictionary } from "../i18n"
import type { PickDelivery } from "../pick-to-composer"
import type { BrowserTab } from "../tab"
import { watchTheme } from "./guest-theme"
import { attachWebviewEvents } from "./webview-events"

const AGENT_BROWSER_PARTITION = "persist:agent-browser"

export function PageHost(props: { readonly tab: BrowserTab; readonly deliver: PickDelivery }): JSX.Element {
  return (
    <Show when={props.tab.bridge} fallback={<WebPreview tab={props.tab} />}>
      {(bridge) => <DesktopPage tab={props.tab} bridge={bridge()} deliver={props.deliver} />}
    </Show>
  )
}

function DesktopPage(props: {
  readonly tab: BrowserTab
  readonly bridge: BrowserBridge
  readonly deliver: PickDelivery
}): JSX.Element {
  let detach: (() => void) | undefined

  const attach = (element: BrowserWebview) => {
    props.tab.attachWebview(element)
    const offEvents = attachWebviewEvents({ element, tab: props.tab, bridge: props.bridge, deliver: props.deliver })
    const offTheme = watchTheme(element)
    detach = () => {
      offEvents()
      offTheme()
    }
  }

  onCleanup(() => {
    detach?.()
    props.tab.attachWebview(undefined)
    props.bridge.unregister(props.tab.paneId).then(
      (result) => {
        if (!result.ok)
          console.warn("Browser page could not be unregistered", { paneId: props.tab.paneId, error: result.error })
      },
      (error: unknown) => console.warn("Browser page could not be unregistered", { paneId: props.tab.paneId, error }),
    )
  })

  return (
    <webview
      ref={attach}
      src="about:blank"
      partition={AGENT_BROWSER_PARTITION}
      class="absolute inset-0 h-full w-full"
    />
  )
}

function WebPreview(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const url = () => props.tab.state().url
  const blocked = () => typeof location !== "undefined" && location.protocol === "https:" && url().startsWith("http:")
  return (
    <Show
      when={url() && !blocked() ? url() : undefined}
      fallback={
        <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <div class="font-medium text-text-base">
            {blocked() ? t("browser.mixedContent.title") : t("browser.web.title")}
          </div>
          <div>{blocked() ? t("browser.mixedContent.hint") : t("browser.web.hint")}</div>
        </div>
      }
    >
      {(src) => (
        <iframe
          src={src()}
          title={t("browser.preview.title")}
          sandbox=""
          referrerPolicy="no-referrer"
          class="size-full border-0 bg-background-base"
          onLoad={() => props.tab.send({ type: "loaded", url: src() })}
        />
      )}
    </Show>
  )
}
