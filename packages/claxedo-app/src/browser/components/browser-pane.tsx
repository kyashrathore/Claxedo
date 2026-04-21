import { type Component, Show, createSignal, onCleanup } from "solid-js"

/**
 * BrowserPane.
 *
 * When the Electron preload bridge (`window.api.browser`) is available — i.e.
 * the desktop app was launched with `CLAXEDO_ENABLE_BROWSER_TAB=1` — this
 * renders a real `<webview>` pinned to the `persist:agent-browser` partition.
 *
 * On `dom-ready`, the pane calls `browser.register(paneId, webContentsId)` so
 * the main-process `BrowserRegistry` can bind the pane to its webContents.
 * Unit 3 will then attach the CDP debugger on top of that handle.
 *
 * When the bridge is absent (cloud / web build, or desktop launched without
 * the flag), the existing fallback UI is preserved so opening the tab stays
 * legible rather than dispatching to "Unknown content type".
 *
 * Lives in `packages/claxedo-app/src/browser/` per the pane-local-frontend-
 * orchestration layer direction.
 */
export type BrowserPaneProps = {
  paneId: string
  browserId?: string
  initialUrl?: string
}

type BrowserApi = {
  enabled: () => Promise<boolean>
  register: (paneId: string, webContentsId: number) => Promise<{ ok: boolean; error?: string }>
  unregister: (paneId: string) => Promise<{ ok: boolean; error?: string }>
  navigate: (paneId: string, url: string) => Promise<{ ok: boolean; error?: string }>
}

type WindowWithBrowserApi = Window & { api?: { browser?: BrowserApi } }

type WebviewElement = HTMLElement & {
  src?: string
  partition?: string
  getWebContentsId?: () => number
  addEventListener: HTMLElement["addEventListener"]
  removeEventListener: HTMLElement["removeEventListener"]
}

const AGENT_BROWSER_PARTITION = "persist:agent-browser"
const DEFAULT_URL = "about:blank"

function getBrowserApi(): BrowserApi | undefined {
  if (typeof window === "undefined") return undefined
  const w = window as WindowWithBrowserApi
  return w.api?.browser
}

export const BrowserPane: Component<BrowserPaneProps> = (props) => {
  const api = getBrowserApi()
  const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined)

  if (api) {
    api
      .enabled()
      .then((value) => setEnabled(Boolean(value)))
      .catch(() => setEnabled(false))
  } else {
    setEnabled(false)
  }

  const showWebview = () => enabled() === true && !!api

  return (
    <div class="flex h-full w-full flex-col bg-background text-foreground">
      <div class="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <span class="font-medium">Browser</span>
        <Show when={props.initialUrl}>
          <span class="truncate text-muted-foreground">{props.initialUrl}</span>
        </Show>
      </div>
      <div class="relative flex-1">
        <div data-testid="browser-pane-webview-host" class="absolute inset-0">
          <Show
            when={showWebview() && api}
            fallback={
              <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                <div class="font-medium text-foreground">Browser tabs require the desktop app.</div>
                <div>
                  Set <code>CLAXEDO_ENABLE_BROWSER_TAB=1</code> and{" "}
                  <code>VITE_CLAXEDO_ENABLE_BROWSER_TAB=true</code> and relaunch to try this feature.
                </div>
              </div>
            }
          >
            {(apiAccessor) => <WebviewHost paneId={props.paneId} initialUrl={props.initialUrl} api={apiAccessor()} />}
          </Show>
        </div>
      </div>
    </div>
  )
}

type WebviewHostProps = {
  paneId: string
  initialUrl?: string
  api: BrowserApi
}

/**
 * Renders the Electron `<webview>` itself. Kept separate from `BrowserPane`
 * so the component only mounts when the bridge is actually available — this
 * avoids Solid firing `onCleanup` on a non-existent webview during SSR or
 * cloud builds.
 */
function WebviewHost(props: WebviewHostProps) {
  const [url] = createSignal(props.initialUrl && props.initialUrl.length > 0 ? props.initialUrl : DEFAULT_URL)
  let webview: WebviewElement | undefined

  const handleDomReady = () => {
    if (!webview) return
    const getId = webview.getWebContentsId
    if (typeof getId !== "function") return
    let wcId: number
    try {
      wcId = getId.call(webview)
    } catch (err) {
      console.warn("[browser-pane] failed to read webContentsId", err)
      return
    }
    void props.api.register(props.paneId, wcId).then((res) => {
      if (!res.ok) {
        console.warn("[browser-pane] registry.register failed", res.error)
      }
    })
  }

  onCleanup(() => {
    if (webview) {
      webview.removeEventListener("dom-ready", handleDomReady as EventListener)
    }
    void props.api.unregister(props.paneId).catch(() => {})
  })

  const attachListeners = (el: WebviewElement) => {
    webview = el
    el.addEventListener("dom-ready", handleDomReady as EventListener)
  }

  return (
    <webview
      ref={attachListeners as unknown as (el: HTMLElement) => void}
      src={url()}
      partition={AGENT_BROWSER_PARTITION}
      class="absolute inset-0 h-full w-full"
      style={{ display: "flex" }}
    />
  )
}
