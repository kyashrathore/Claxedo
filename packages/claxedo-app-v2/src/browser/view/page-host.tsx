import { Match, Show, Switch, onCleanup } from "solid-js"
import type { BrowserBridge, BrowserWebview } from "../bridge"
import { t } from "../i18n"
import type { BrowserTab } from "../tab"
import { watchTheme } from "./guest-theme"
import { PageState } from "./page-state"
import { attachWebviewEvents } from "./webview-events"

const AGENT_BROWSER_PARTITION = "persist:agent-browser"

export function PageHost(props: { readonly tab: BrowserTab }) {
  return (
    <>
      <Show when={props.tab.bridge} fallback={<WebPreview tab={props.tab} />}>
        {(bridge) => <DesktopPage tab={props.tab} bridge={bridge()} />}
      </Show>
      <PageState tab={props.tab} />
    </>
  )
}

function DesktopPage(props: { readonly tab: BrowserTab; readonly bridge: BrowserBridge }) {
  let detach: (() => void) | undefined

  const attach = (element: BrowserWebview) => {
    props.tab.attachWebview(element)
    const offEvents = attachWebviewEvents({ element, tab: props.tab, bridge: props.bridge })
    const offTheme = watchTheme(element)
    detach = () => {
      offEvents()
      offTheme()
    }
  }

  onCleanup(() => {
    detach?.()
    props.tab.attachWebview(undefined)
    void props.bridge.unregister(props.tab.paneId).then((result) => {
      if (!result.ok) console.warn("browser: unregister failed", props.tab.paneId, result.error)
    })
  })

  return <webview ref={attach} src="about:blank" partition={AGENT_BROWSER_PARTITION} class="absolute inset-0 h-full w-full" />
}

function WebPreview(props: { readonly tab: BrowserTab }) {
  const url = () => props.tab.state().url
  const blocked = () => typeof location !== "undefined" && location.protocol === "https:" && url().startsWith("http:")
  return (
    <Switch>
      <Match when={!url()}>
        <div class="absolute inset-0 bg-background-base" />
      </Match>
      <Match when={blocked()}>
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background-base p-6 text-center">
          <div class="text-12-medium text-text-base">{t("browser.mixedContent.title")}</div>
          <div class="text-12-regular text-text-weak">{t("browser.mixedContent.hint")}</div>
        </div>
      </Match>
      <Match when={true}>
        <iframe
          src={url()}
          title={t("browser.preview.title")}
          sandbox=""
          referrerPolicy="no-referrer"
          class="absolute inset-0 h-full w-full border-0 bg-background-base"
          onLoad={() => props.tab.send({ type: "loaded", url: url() })}
        />
      </Match>
    </Switch>
  )
}
