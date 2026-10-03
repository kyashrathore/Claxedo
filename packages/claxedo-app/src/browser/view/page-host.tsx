import { Show, createEffect, onCleanup, type JSX } from "solid-js"
import type { BrowserBridge, BrowserWebview } from "../bridge"
import type { PickDelivery } from "../pick-to-composer"
import type { BrowserTab } from "../tab"
import { watchTheme } from "./guest-theme"
import { WebPreview } from "./web-preview"
import { attachWebviewEvents } from "./webview-events"

const AGENT_BROWSER_PARTITION = "persist:agent-browser"

export function PageHost(props: { readonly tab: BrowserTab; readonly active: boolean; readonly deliver: PickDelivery }): JSX.Element {
  return (
    <Show when={props.tab.bridge} fallback={<WebPreview tab={props.tab} />}>
      {(bridge) => <DesktopPage tab={props.tab} active={props.active} bridge={bridge()} deliver={props.deliver} />}
    </Show>
  )
}

function DesktopPage(props: {
  readonly tab: BrowserTab
  readonly active: boolean
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

  createEffect(() => {
    const element = props.tab.webview()
    if (element && props.tab.registered()) element.setAudioMuted?.(!props.active)
  })

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
