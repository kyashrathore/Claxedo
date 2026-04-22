import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"

import {
  BrowserPaneProvider,
  useBrowserPane,
  type BrowserBridgeApi,
} from "../store/browser-pane-context"
import { useBrowserComments } from "../store/browser-comments"
import { autoBind, sendPageComment, usePane } from "../../claxedo-ui/context/pane-bus"
import { formatElementCommentNote } from "../utils/format-element-comment-note"
import { ElementCommentComposer } from "./element-comment-composer"

/**
 * BrowserPane.
 *
 * When the Electron preload bridge (`window.api.browser`) is available — i.e.
 * the desktop app was launched with `CLAXEDO_ENABLE_BROWSER_TAB=1` — this
 * renders a real `<webview>` pinned to the `persist:agent-browser` partition.
 *
 * On `dom-ready`, the pane calls `browser.register(paneId, webContentsId)` so
 * the main-process `BrowserRegistry` can bind the pane to its webContents,
 * and the CDP state machine (Unit 3) takes over from there.
 *
 * When the bridge is absent (cloud / web build, or desktop launched without
 * the flag), the existing fallback UI is preserved so opening the tab stays
 * legible rather than dispatching to "Unknown content type".
 */
export type BrowserPaneProps = {
  paneId: string
  tabId?: string
  browserId?: string
  initialUrl?: string
}

type WindowWithBrowserApi = Window & { api?: { browser?: BrowserBridgeApi } }

type WebviewElement = HTMLElement & {
  src?: string
  partition?: string
  getWebContentsId?: () => number
  addEventListener: HTMLElement["addEventListener"]
  removeEventListener: HTMLElement["removeEventListener"]
}

const AGENT_BROWSER_PARTITION = "persist:agent-browser"
const DEFAULT_URL = "about:blank"

function getBrowserApi(): BrowserBridgeApi | undefined {
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
    <BrowserPaneProvider paneId={props.paneId} bridge={api} initialUrl={props.initialUrl}>
      <BrowserPaneBusBridge leafId={props.paneId} tabId={props.tabId} />
      <div class="flex h-full w-full flex-col bg-background text-foreground">
        <BrowserPaneHeader initialUrl={props.initialUrl} />
        <BrowserPaneElementCommentArea leafId={props.paneId} tabId={props.tabId} />
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
              {(apiAccessor) => (
                <WebviewHost paneId={props.paneId} initialUrl={props.initialUrl} api={apiAccessor()} />
              )}
            </Show>
            <BrowserPaneInspectShield />
          </div>
        </div>
        <BrowserPaneConsoleDrawer />
      </div>
    </BrowserPaneProvider>
  )
}

/**
 * Registers the browser pane as a `page-comment:produce` publisher on the
 * pane bus and auto-binds to a single sibling session consumer. When no
 * `tabId` is supplied (e.g. rendered outside a claxedo multi-pane shell)
 * we skip registration entirely — the `useBrowserComments()` history still
 * works for the local pane, there's just nowhere to route payloads to.
 */
function BrowserPaneBusBridge(props: { leafId: string; tabId?: string }) {
  if (!props.tabId) return null
  const tabId = props.tabId
  usePane({
    leafId: props.leafId,
    tabId,
    type: "browser",
    name: () => "Browser",
    capabilities: ["page-comment:produce"],
    handlers: {
      "page-comment:produce": {},
    },
  })

  createEffect(() => {
    autoBind(props.leafId, "page-comment", "page-comment:receive")
  })
  return null
}

/**
 * Mounted below the header. When the inspector surfaces a selected node
 * (via Unit 5), this area swaps from the lightweight selector banner to a
 * full `ElementCommentComposer`. On submit, the payload is added to the
 * claxedo-owned `useBrowserComments` store (for local history) and routed
 * to the bound session via `sendPageComment`.
 */
function BrowserPaneElementCommentArea(props: { leafId: string; tabId?: string }) {
  const ctx = useBrowserPane()
  const [composing, setComposing] = createSignal(false)
  let browserComments: ReturnType<typeof useBrowserComments> | undefined
  try {
    browserComments = useBrowserComments()
  } catch {
    // Tests or non-app contexts — local history write silently skipped,
    // but pane-bus routing still works so the session consumer enqueues.
  }

  const handleSubmit = (payload: {
    tabId: string
    pageUrl: string
    selector: string
    comment: string
    noteText: string
    boundingBox?: { x: number; y: number; width: number; height: number }
    outerHTML?: string
    screenshotDataUrl?: string
  }) => {
    // History: record under the producer's tabId even when we can't send.
    if (browserComments) {
      browserComments.add({
        tabId: payload.tabId,
        pageUrl: payload.pageUrl,
        selector: payload.selector,
        comment: payload.comment,
        noteText: payload.noteText,
        boundingBox: payload.boundingBox,
        outerHTML: payload.outerHTML,
        screenshotDataUrl: payload.screenshotDataUrl,
      })
    }
    // Route to session consumer, which enqueues under its own sessionId.
    sendPageComment(props.leafId, payload)
    ctx.clearLastSelectedNode()
    setComposing(false)
  }

  const cancel = () => {
    ctx.clearLastSelectedNode()
    setComposing(false)
  }

  const startComposing = () => setComposing(true)

  return (
    <Show
      when={ctx.lastSelectedNode()}
      fallback={null}
    >
      {(nodeAccessor) => {
        const node = nodeAccessor()
        if (!node.ok) {
          return (
            <div
              class="flex items-start gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs"
              data-testid="browser-pane-selected-node"
            >
              <div class="flex-1 overflow-hidden">
                <span class="text-red-500">
                  Inspect failed: {node.error}
                  {node.message ? ` – ${node.message}` : ""}
                </span>
              </div>
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground"
                onClick={() => ctx.clearLastSelectedNode()}
                data-testid="browser-pane-selected-node-dismiss"
              >
                ×
              </button>
            </div>
          )
        }
        return (
          <Show
            when={composing()}
            fallback={
              <div
                class="flex items-start gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-xs"
                data-testid="browser-pane-selected-node"
              >
                <div class="flex-1 overflow-hidden">
                  <span class="mr-1 font-mono text-foreground">{node.selector}</span>
                  <Show when={node.frameUrl}>
                    <span class="text-muted-foreground"> · {node.frameUrl}</span>
                  </Show>
                </div>
                <button
                  type="button"
                  class="text-xs text-foreground hover:underline"
                  data-testid="browser-pane-selected-node-comment"
                  onClick={startComposing}
                >
                  Comment
                </button>
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground"
                  onClick={() => ctx.clearLastSelectedNode()}
                  data-testid="browser-pane-selected-node-dismiss"
                >
                  ×
                </button>
              </div>
            }
          >
            <ElementCommentComposer
              tabId={props.tabId ?? ""}
              pageUrl={node.frameUrl}
              node={node}
              formatNote={formatElementCommentNote}
              onElementComment={handleSubmit}
              onCancel={cancel}
            />
          </Show>
        )
      }}
    </Show>
  )
}

function BrowserPaneHeader(props: { initialUrl?: string }) {
  const ctx = useBrowserPane()
  return (
    <div class="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <span class="font-medium">Browser</span>
      <Show when={props.initialUrl}>
        <span class="truncate text-muted-foreground">{props.initialUrl}</span>
      </Show>
      <div class="ml-auto flex items-center gap-3">
        <button
          type="button"
          classList={{
            "rounded border px-2 py-0.5 text-xs": true,
            "border-primary text-primary": ctx.inspectMode(),
            "border-border text-muted-foreground hover:text-foreground": !ctx.inspectMode(),
          }}
          onClick={() => {
            void ctx.setInspectMode(!ctx.inspectMode())
          }}
          data-testid="browser-pane-inspect-toggle"
          aria-pressed={ctx.inspectMode()}
        >
          {ctx.inspectMode() ? "Inspecting..." : "Inspect"}
        </button>
        <label class="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={ctx.agentAllowed()}
            onChange={(e) => {
              void ctx.setAgentAllowed((e.currentTarget as HTMLInputElement).checked)
            }}
            data-testid="browser-pane-agent-allowed-toggle"
          />
          Allow agent to run JS
        </label>
        <button
          type="button"
          class="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => ctx.setConsoleDrawerOpen(!ctx.consoleDrawerOpen())}
          data-testid="browser-pane-console-toggle"
        >
          Console ({ctx.consoleEntries().length})
        </button>
      </div>
    </div>
  )
}

/**
 * Collapsible console drawer. Uses CSS `hidden` (display:none) to preserve
 * the DOM subtree across toggles — per MEMORY.md, `<Show>` causes 800ms+
 * jank on large trees. The drawer's children stay mounted; only visibility
 * flips.
 */
function BrowserPaneConsoleDrawer() {
  const ctx = useBrowserPane()
  return (
    <div
      classList={{
        "border-t border-border bg-background": true,
        hidden: !ctx.consoleDrawerOpen(),
      }}
      data-testid="browser-pane-console-drawer"
      style={{ "max-height": "40%", overflow: "auto" }}
    >
      <div class="flex items-center justify-between px-3 py-1 text-xs text-muted-foreground">
        <span>Console ({ctx.consoleEntries().length})</span>
        <button
          type="button"
          class="text-xs hover:text-foreground"
          onClick={() => ctx.clearConsole()}
          data-testid="browser-pane-console-clear"
        >
          Clear
        </button>
      </div>
      <ul class="divide-y divide-border font-mono text-xs">
        <For each={ctx.consoleEntries()}>
          {(entry) => (
            <li
              classList={{
                "px-3 py-1": true,
                "text-red-500": entry.level === "error",
                "text-yellow-500": entry.level === "warn",
                "text-muted-foreground": entry.level === "debug",
              }}
            >
              <span class="mr-2 uppercase opacity-70">{entry.level}</span>
              <span>{entry.args.join(" ")}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

/**
 * When inspect mode is on, the Chromium-native overlay already handles the
 * click and dispatches `Overlay.inspectNodeRequested`. However, the
 * surrounding renderer UI (menus, context-menus, double-click handlers)
 * should not fire. This shield sits above the webview only while inspect is
 * on; the overlay passes clicks through to the guest via CDP.
 *
 * The shield is `pointer-events: auto` but it does NOT visually occlude —
 * Chromium's picker already dims the page.
 */
function BrowserPaneInspectShield() {
  const ctx = useBrowserPane()
  return (
    <Show when={ctx.inspectMode()}>
      <div
        class="absolute inset-0"
        style={{
          "pointer-events": "none",
          // Crosshair cursor on the renderer so the outer UI also reflects
          // that the user is in pick mode.
          cursor: "crosshair",
        }}
        data-testid="browser-pane-inspect-shield"
        aria-hidden="true"
      />
    </Show>
  )
}

type WebviewHostProps = {
  paneId: string
  initialUrl?: string
  api: BrowserBridgeApi
}

/**
 * Renders the Electron `<webview>` itself. Kept separate from `BrowserPane`
 * so the component only mounts when the bridge is actually available — this
 * avoids Solid firing `onCleanup` on a non-existent webview during SSR or
 * cloud builds.
 */
function WebviewHost(props: WebviewHostProps) {
  const ctx = useBrowserPane()
  const [url] = createSignal(props.initialUrl && props.initialUrl.length > 0 ? props.initialUrl : DEFAULT_URL)
  let webview: WebviewElement | undefined

  const handleDomReady = () => {
    ctx.setLoading(false)
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

  const handleDidNavigate = (e: Event & { url?: string }) => {
    ctx.setCurrentUrl((e as unknown as { url?: string }).url)
  }

  onCleanup(() => {
    if (webview) {
      webview.removeEventListener("dom-ready", handleDomReady as EventListener)
      webview.removeEventListener("did-navigate", handleDidNavigate as EventListener)
    }
    void props.api.unregister(props.paneId).catch(() => {})
  })

  const attachListeners = (el: WebviewElement) => {
    webview = el
    el.addEventListener("dom-ready", handleDomReady as EventListener)
    el.addEventListener("did-navigate", handleDidNavigate as EventListener)
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
