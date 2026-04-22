import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

import {
  BrowserPaneProvider,
  useBrowserPane,
  type BrowserBridgeApi,
} from "../store/browser-pane-context"
import { useBrowserComments } from "../store/browser-comments"
import { useBrowserHistory, type BrowserHistoryState } from "../store/browser-history"
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
  /**
   * Invoked when the guest webview navigates or its page title updates.
   * Lets the host update the persisted `TabItem` so close+reopen restores
   * the last-known URL / title. Optional: in tests or isolated previews
   * the callback is simply absent.
   */
  onNavigationChange?: (patch: { currentUrl?: string; pageTitle?: string }) => void
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

  // History is optional: outside the provider (tests, cloud builds) we simply
  // skip recording without breaking the pane.
  let history: BrowserHistoryState | undefined
  try {
    history = useBrowserHistory()
  } catch {
    history = undefined
  }

  return (
    <BrowserPaneProvider paneId={props.paneId} bridge={api} initialUrl={props.initialUrl}>
      <BrowserPaneBusBridge leafId={props.paneId} tabId={props.tabId} />
      <div class="flex h-full w-full flex-col bg-background text-foreground">
        <BrowserPaneHeader
          initialUrl={props.initialUrl}
          browserId={props.browserId}
          history={history}
          api={api}
        />
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
                <WebviewHost
                  paneId={props.paneId}
                  initialUrl={props.initialUrl}
                  api={apiAccessor()}
                  browserId={props.browserId}
                  history={history}
                  onNavigationChange={props.onNavigationChange}
                />
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

function BrowserPaneHeader(props: {
  initialUrl?: string
  browserId?: string
  history?: BrowserHistoryState
  api?: BrowserBridgeApi
}) {
  const ctx = useBrowserPane()
  return (
    <div class="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <span class="font-medium">Browser</span>
      <BrowserAddressBar initialUrl={props.initialUrl} api={props.api} history={props.history} />
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
 * Address bar with a simple autocomplete popover backed by the
 * `useBrowserHistory` recent-URL list. Uses substring + prefix matching
 * (see `matchRecent` in the history store). No fuzzy library is available
 * in the repo and plan permits substring matching for v1.
 */
function BrowserAddressBar(props: {
  initialUrl?: string
  api?: BrowserBridgeApi
  history?: BrowserHistoryState
}) {
  const ctx = useBrowserPane()
  const [draft, setDraft] = createSignal(props.initialUrl ?? "")
  const [focused, setFocused] = createSignal(false)

  // Keep the address bar in sync with the pane context, unless the user is
  // actively editing (we don't want to stomp their draft mid-type).
  createEffect(() => {
    const live = ctx.currentUrl()
    if (!focused() && live !== undefined) setDraft(live)
  })

  const suggestions = createMemo(() => {
    const h = props.history
    if (!h) return []
    const q = draft()
    const matches = h.matchRecent(q, 8)
    const current = ctx.currentUrl()
    return matches.filter((m) => m.url !== current)
  })

  const commit = (url: string) => {
    const trimmed = url.trim()
    if (!trimmed) return
    setDraft(trimmed)
    if (props.api && trimmed !== ctx.currentUrl()) {
      // paneId lives on the context; navigate is async but we don't block.
      // The main-process side handles invalid URLs with a structured error.
      void props.api
        .navigate(ctx.paneId(), trimmed)
        .catch((err) => console.warn("[browser-pane] navigate failed", err))
    }
    setFocused(false)
  }

  return (
    <div class="relative flex flex-1 items-center" data-testid="browser-pane-address-bar-host">
      <input
        type="text"
        value={draft()}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          // Defer so a click on a suggestion can still apply before close.
          setTimeout(() => setFocused(false), 120)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit(draft())
          } else if (e.key === "Escape") {
            setFocused(false)
          }
        }}
        placeholder="Enter a URL"
        spellcheck={false}
        class="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground focus:text-foreground focus:outline-none"
        data-testid="browser-pane-address-bar"
      />
      <Show when={focused() && suggestions().length > 0}>
        <ul
          class="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-auto rounded border border-border bg-background text-xs shadow"
          data-testid="browser-pane-address-bar-suggestions"
        >
          <For each={suggestions()}>
            {(entry) => (
              <li
                class="cursor-pointer px-2 py-1 hover:bg-muted/40"
                onMouseDown={(e) => {
                  // Use onMouseDown so this fires before the input's blur.
                  e.preventDefault()
                  commit(entry.url)
                }}
                data-testid="browser-pane-address-bar-suggestion"
              >
                <span class="truncate font-mono text-foreground">{entry.url}</span>
                <Show when={entry.title}>
                  <span class="ml-2 text-muted-foreground">· {entry.title}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
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
  browserId?: string
  history?: BrowserHistoryState
  onNavigationChange?: (patch: { currentUrl?: string; pageTitle?: string }) => void
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
    const url = (e as unknown as { url?: string }).url
    ctx.setCurrentUrl(url)
    if (url && props.browserId && props.history) {
      props.history.visit({ browserId: props.browserId, url })
    }
    if (url && props.onNavigationChange) {
      props.onNavigationChange({ currentUrl: url })
    }
  }

  const handlePageTitleUpdated = (e: Event & { title?: string }) => {
    const title = (e as unknown as { title?: string }).title
    const url = ctx.currentUrl()
    if (title && url && props.browserId && props.history) {
      props.history.visit({ browserId: props.browserId, url, title })
    }
    if (title && props.onNavigationChange) {
      props.onNavigationChange({ pageTitle: title })
    }
  }

  onCleanup(() => {
    if (webview) {
      webview.removeEventListener("dom-ready", handleDomReady as EventListener)
      webview.removeEventListener("did-navigate", handleDidNavigate as EventListener)
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated as EventListener)
    }
    void props.api.unregister(props.paneId).catch(() => {})
  })

  const attachListeners = (el: WebviewElement) => {
    webview = el
    el.addEventListener("dom-ready", handleDomReady as EventListener)
    el.addEventListener("did-navigate", handleDidNavigate as EventListener)
    el.addEventListener("page-title-updated", handlePageTitleUpdated as EventListener)
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
