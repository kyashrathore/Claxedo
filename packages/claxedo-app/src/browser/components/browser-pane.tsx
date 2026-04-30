import { For, Show, createEffect, createMemo, createSignal, onCleanup, type Component } from "solid-js"

import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { showToast } from "@opencode-ai/ui/toast"

import {
  BrowserPaneProvider,
  useBrowserPane,
  type BrowserBridgeApi,
  type BrowserNodeSelectedPayload,
} from "../store/browser-pane-context"
import { useBrowserHistory, type BrowserHistoryState } from "../store/browser-history"

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
/**
 * Element-comment payload routed up to the parent (WorkspaceBrowserPanel).
 * Shape preserved from the deleted pane-bus PageElementCommentPayload so
 * downstream consumers (browser-comments store, prompt.context.add) keep
 * the same fields without re-deriving them.
 */
export type BrowserPaneCommentPayload = {
  tabId: string
  pageUrl: string
  selector: string
  comment: string
  noteText: string
  outerHTML?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
}

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
  /**
   * Invoked when the guest fires a comment-submit event. The parent decides
   * routing — typically calls `prompt.context.add(...)` on the focused
   * session. Returns true if the comment reached a session, false if it
   * was only persisted locally. When omitted, the BrowserPane still
   * records the comment in the local history store but no toast is shown.
   */
  onPageComment?: (payload: BrowserPaneCommentPayload) => boolean
}

type WindowWithBrowserApi = Window & { api?: { browser?: BrowserBridgeApi } }

type WebviewElement = HTMLElement & {
  src?: string
  partition?: string
  getWebContentsId?: () => number
  /**
   * Webview-direct IPC. Electron's `<webview>` tag exposes `.send(channel,
   * ...args)` to dispatch into the guest preload's `ipcRenderer.on(channel,
   * …)`, and the guest fires `ipc-message` on the element when it calls
   * `ipcRenderer.sendToHost(channel, …)`. This is how the react-grab preload
   * pipes picked-element payloads back to the host renderer without going
   * through the main process.
   */
  send?: (channel: string, ...args: unknown[]) => void
  addEventListener: HTMLElement["addEventListener"]
  removeEventListener: HTMLElement["removeEventListener"]
}

/**
 * Structured payload received from the guest preload's `sendToHost`. Kept in
 * sync with `PickPayload` in `packages/claxedo-desktop/src/browser-preload/`.
 * Converting to the renderer's `BrowserNodeSelectedPayload` shape happens in
 * `handleGuestPick` below.
 */
type GuestPickPayload = {
  selector?: string
  frameUrl?: string
  tagName?: string
  outerHTML?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  computedStyles?: {
    color?: string
    backgroundColor?: string
    fontFamily?: string
    fontSize?: string
    display?: string
  }
}

const AGENT_BROWSER_PARTITION = "persist:agent-browser"
const DEFAULT_URL = "about:blank"

// Injected once per renderer. Targets the guest <webview> so pointer events
// fall through to the host window during a drag-resize — Electron's guest
// process otherwise captures pointer events across the handle's path and
// the drag hangs until the cursor leaves the webview bounds.
const BROWSER_PANE_RESIZE_STYLE_ID = "claxedo-browser-pane-resize-style"
function ensureBrowserPaneResizeStyle(): void {
  if (typeof document === "undefined") return
  if (document.getElementById(BROWSER_PANE_RESIZE_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = BROWSER_PANE_RESIZE_STYLE_ID
  style.textContent =
    'html[data-terminal-resize-suspended="1"] [data-testid="browser-pane-webview-host"] webview { pointer-events: none !important; }'
  document.head.appendChild(style)
}

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

  // React-grab now owns the entire in-page comment UX — hover overlay,
  // selection label, and the floating "Add a comment…" popover. The old
  // bottom composer dock has been removed to match the reference design
  // (single inline composer attached to the picked element).
  const [webviewHostEl, setWebviewHostEl] = createSignal<HTMLDivElement | undefined>(undefined)

  // While a pane-split or terminal resize is in progress, the renderer
  // sets `document.documentElement.dataset.terminalResizeSuspended = "1"`.
  // The Electron <webview> guest captures pointer events across process
  // boundaries — so a drag that starts on a sibling handle and crosses
  // over the webview loses the subsequent `pointermove`/`pointerup`
  // events (drag appears to hang and never release). Forcing the webview
  // to `pointer-events: none` during that flag lets pointer events flow
  // back to the host window and the drag tracks normally.
  ensureBrowserPaneResizeStyle()

  return (
    <BrowserPaneProvider paneId={props.paneId} bridge={api} initialUrl={props.initialUrl}>
      <BrowserPaneKeyboardHandlers />
      <div class="flex h-full w-full flex-col bg-background-base text-text-base">
        <BrowserPaneToolbar
          initialUrl={props.initialUrl}
          browserId={props.browserId}
          history={history}
          api={api}
        />
        <div class="relative flex-1">
          <div
            ref={setWebviewHostEl}
            data-testid="browser-pane-webview-host"
            class="absolute inset-0"
            classList={{
              // Subtle ring so the user sees that clicks on the page will be
              // consumed by the picker, not the site.
              "ring-2 ring-border-strong-base ring-inset": false, // driven below via <BrowserPaneInspectRing />
            }}
          >
            <Show
              when={showWebview() && api}
              fallback={
                <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                  <div class="font-medium text-text-base">Browser tabs require the desktop app.</div>
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
                  tabId={props.tabId}
                  initialUrl={props.initialUrl}
                  api={apiAccessor()}
                  browserId={props.browserId}
                  history={history}
                  onNavigationChange={props.onNavigationChange}
                  onPageComment={props.onPageComment}
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
 * Global-ish keyboard affordances for the pane. Today: Esc cancels inspect
 * mode. We attach on `window` while the pane is mounted so users can bail out
 * of the picker without having to reach for the toolbar button.
 */
function BrowserPaneKeyboardHandlers() {
  const ctx = useBrowserPane()
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return
    // Two distinct Esc paths: (1) user is actively picking → cancel the
    // picker, (2) user already picked an element and is looking at the
    // floating info card → dismiss the selection. Previously only (1) was
    // wired, so the card had no keyboard dismissal.
    if (ctx.inspectMode()) {
      void ctx.setInspectMode(false)
      return
    }
    if (ctx.lastSelectedNode()) {
      ctx.clearLastSelectedNode()
    }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  }
  return null
}

/**
 * Slim inspect-mode pill rendered inline in the toolbar. Replaces the old
 * full-width banner — users saw that as a system alert and it shifted the
 * webview. The pill sits next to the Inspect toggle so the state and the
 * control are adjacent.
 */
function BrowserPaneInspectPill() {
  const ctx = useBrowserPane()
  return (
    <Show when={ctx.inspectMode()}>
      <div
        class="flex h-6 items-center gap-1.5 rounded-md bg-surface-base-interactive-active px-2 text-12-medium text-text-base"
        data-testid="browser-pane-inspect-banner"
        role="status"
      >
        <span>Picking element</span>
        <kbd class="rounded border border-border-weak-base bg-background-base px-1 text-12-mono text-text-weak">Esc</kbd>
      </div>
    </Show>
  )
}

/**
 * Toolbar row. Back / forward / reload, the address bar, inspect toggle, and
 * an overflow menu for less-frequent actions. Mirrors the affordances users
 * expect from a real browser chrome; see `superset-terminal-ref` for prior
 * art on the 3-dot menu contents.
 */
function BrowserPaneToolbar(props: {
  initialUrl?: string
  browserId?: string
  history?: BrowserHistoryState
  api?: BrowserBridgeApi
}) {
  const ctx = useBrowserPane()

  const copyCurrentUrl = async () => {
    const url = ctx.currentUrl() ?? ""
    if (!url) return
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      }
      showToast({ title: "URL copied", variant: "success", duration: 1500 })
    } catch {
      showToast({ title: "Failed to copy URL", variant: "error", duration: 2500 })
    }
  }

  const takeScreenshot = async () => {
    const res = await ctx.captureScreenshot()
    if (!res.ok) {
      showToast({
        title: `Screenshot failed: ${res.error.code}`,
        variant: "error",
        duration: 3500,
      })
      return
    }
    showToast({ title: "Screenshot captured", variant: "success", duration: 2000 })
  }

  const hardReload = async () => {
    const r = await ctx.reload(true)
    if (!r.ok) {
      showToast({ title: `Hard reload failed: ${r.error ?? ""}`, variant: "error", duration: 2500 })
    }
  }

  const openDevTools = async () => {
    const r = await ctx.openDevTools()
    if (!r.ok) {
      showToast({
        title: `Could not open DevTools: ${r.error ?? ""}`,
        variant: "error",
        duration: 3500,
      })
    }
  }

  const clearCookies = async () => {
    const r = await ctx.clearCookies()
    if (r.ok) {
      showToast({ title: "Cookies cleared for agent browser", variant: "success", duration: 2500 })
    } else {
      showToast({ title: `Clear cookies failed: ${r.error ?? ""}`, variant: "error", duration: 3500 })
    }
  }

  return (
    <div
      class="flex h-10 items-center gap-2 border-b border-border-weak-base bg-background-base px-2 text-12-regular"
      data-testid="browser-pane-toolbar"
    >
      {/* Navigation cluster: back / forward / reload grouped with tighter spacing */}
      <div class="flex items-center gap-0.5">
        <Tooltip value="Go back" placement="bottom">
          <IconButton
            icon="arrow-left"
            variant="ghost"
            size="small"
            aria-label="Go back"
            disabled={!ctx.canGoBack()}
            onClick={() => void ctx.goBack()}
            data-testid="browser-pane-back"
          />
        </Tooltip>
        <Tooltip value="Go forward" placement="bottom">
          <IconButton
            icon="arrow-right"
            variant="ghost"
            size="small"
            aria-label="Go forward"
            disabled={!ctx.canGoForward()}
            onClick={() => void ctx.goForward()}
            data-testid="browser-pane-forward"
          />
        </Tooltip>
        <Tooltip value="Reload" placement="bottom">
          <IconButton
            icon="reset"
            variant="ghost"
            size="small"
            aria-label="Reload"
            onClick={() => void ctx.reload(false)}
            data-testid="browser-pane-reload"
          />
        </Tooltip>
      </div>
      <BrowserAddressBar initialUrl={props.initialUrl} api={props.api} history={props.history} />
      <BrowserPaneInspectPill />
      {/* Right cluster: inspect, console, overflow — tighter spacing internally,
          larger gap from address bar so the purpose is visually distinct. */}
      <div class="flex items-center gap-0.5">
        <Tooltip value="Pick an element to annotate" placement="bottom">
          <IconButton
            icon="window-cursor"
            size="small"
            variant={ctx.inspectMode() ? "secondary" : "ghost"}
            aria-label="Inspect element"
            aria-pressed={ctx.inspectMode()}
            onClick={() => void ctx.setInspectMode(!ctx.inspectMode())}
            data-testid="browser-pane-inspect-toggle"
          />
        </Tooltip>
        <Tooltip value="Toggle console" placement="bottom">
          <button
            type="button"
            class="flex h-7 items-center gap-1 rounded-md px-1.5 text-12-medium text-text-weak hover:bg-surface-base-hover hover:text-text-base aria-pressed:bg-surface-base-hover aria-pressed:text-text-base"
            onClick={() => ctx.setConsoleDrawerOpen(!ctx.consoleDrawerOpen())}
            data-testid="browser-pane-console-toggle"
            aria-pressed={ctx.consoleDrawerOpen()}
          >
            <Icon name="console" size="small" />
            <span class="tabular-nums">{ctx.consoleEntries().length}</span>
          </button>
        </Tooltip>
        <DropdownMenu gutter={4} placement="bottom-end">
          <Tooltip value="Browser options" placement="bottom">
            <DropdownMenu.Trigger
              class="flex h-7 w-7 items-center justify-center rounded-md text-text-weak hover:bg-surface-base-hover hover:text-text-base"
              aria-label="Browser options"
              data-testid="browser-pane-menu-trigger"
            >
              <Icon name="kebab" size="small" />
            </DropdownMenu.Trigger>
          </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-testid="browser-pane-menu">
            <DropdownMenu.Item onSelect={() => void takeScreenshot()} data-testid="browser-pane-menu-screenshot">
              <Icon name="photo" size="small" />
              Take Screenshot
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void openDevTools()} data-testid="browser-pane-menu-devtools">
              <Icon name="code" size="small" />
              Open DevTools
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void hardReload()} data-testid="browser-pane-menu-hard-reload">
              <Icon name="reset" size="small" />
              Hard Reload
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => void copyCurrentUrl()} data-testid="browser-pane-menu-copy-url">
              <Icon name="copy" size="small" />
              Copy URL
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => void clearCookies()} data-testid="browser-pane-menu-clear-cookies">
              <Icon name="trash" size="small" />
              Clear Cookies
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.CheckboxItem
              checked={ctx.agentAllowed()}
              onChange={(v) => void ctx.setAgentAllowed(Boolean(v))}
              closeOnSelect={false}
              data-testid="browser-pane-menu-agent-allowed"
            >
              <span class="flex-1">Allow agent to run JS</span>
            </DropdownMenu.CheckboxItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * Normalize an address-bar input into a navigable URL, matching typical
 * browser behavior:
 *  - `https://example.com/x` → passthrough
 *  - `http://localhost:3000` → passthrough
 *  - `example.com`, `x.com`, `localhost:3000` → prepend `https://`
 *  - `how to bake` (no dot, has space) → Google search
 *  - `/absolute` or `127.0.0.1` → prepend `http://` for localhost, else search
 * Anything else that looks URL-ish (no space, has dot or colon) gets `https://`.
 */
export function normalizeAddressBarInput(raw: string): string {
  const s = raw.trim()
  if (!s) return s
  // Already has a scheme
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s
  // Relative-root or obvious search query (has whitespace)
  if (/\s/.test(s)) {
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`
  }
  // localhost / IP / host:port / domain.tld → prepend https://
  // Rough URL-ish heuristic: contains a dot OR is literally "localhost" OR "host:port"
  const looksLikeUrl = s.includes(".") || /^localhost(:\d+)?/i.test(s) || /^[a-z0-9-]+:\d+/i.test(s)
  if (looksLikeUrl) {
    // Localhost / 127.0.0.1 typically mean http
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(s)) return `http://${s}`
    return `https://${s}`
  }
  // Single bare word → search
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/**
 * Address bar with a simple autocomplete popover backed by the
 * `useBrowserHistory` recent-URL list. Uses substring + prefix matching
 * (see `matchRecent` in the history store). No fuzzy library is available
 * in the repo and plan permits substring matching for v1.
 *
 * Styled to match the rest of the chrome — flat input with a focus ring
 * rather than the raw `<input>` border that shipped in Unit 7.
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
    const normalized = normalizeAddressBarInput(trimmed)
    setDraft(normalized)
    if (props.api && normalized !== ctx.currentUrl()) {
      // paneId lives on the context; navigate is async but we don't block.
      // The main-process side handles invalid URLs with a structured error.
      void props.api
        .navigate(ctx.paneId(), normalized)
        .catch((err) => console.warn("[browser-pane] navigate failed", err))
    }
    setFocused(false)
  }

  const inspecting = () => ctx.inspectMode()

  return (
    <div class="relative flex min-w-0 flex-1 items-center" data-testid="browser-pane-address-bar-host">
      <div
        classList={{
          "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-surface-base px-2 transition-colors": true,
          "border-border-weak-base focus-within:border-border-strong-base focus-within:bg-background-base": !inspecting(),
          "border-border-active bg-surface-base-interactive-active": inspecting(),
        }}
      >
        <Icon
          name="magnifying-glass"
          size="small"
          class="shrink-0"
          classList={{
            "text-text-weak": !focused() && !inspecting(),
            "text-text-base": focused() || inspecting(),
          }}
        />
        <input
          type="text"
          value={draft()}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          onFocus={(e) => {
            setFocused(true)
            // Select all on focus for quick replacement — matches Chromium.
            try {
              (e.currentTarget as HTMLInputElement).select()
            } catch {
              // ignore
            }
          }}
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
              const live = ctx.currentUrl()
              if (live !== undefined) setDraft(live)
              ;(e.currentTarget as HTMLInputElement).blur()
            }
          }}
          placeholder="Search or enter URL"
          spellcheck={false}
          class="min-w-0 flex-1 bg-transparent text-12-regular text-text-base placeholder:text-text-weak focus:outline-none"
          data-testid="browser-pane-address-bar"
        />
      </div>
      <Show when={focused() && suggestions().length > 0}>
        <ul
          class="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-auto rounded-md border border-border-weak-base bg-background-base py-1 text-12-regular shadow-lg"
          data-testid="browser-pane-address-bar-suggestions"
        >
          <For each={suggestions()}>
            {(entry) => (
              <li
                class="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-surface-base-hover"
                onMouseDown={(e) => {
                  // Use onMouseDown so this fires before the input's blur.
                  e.preventDefault()
                  commit(entry.url)
                }}
                data-testid="browser-pane-address-bar-suggestion"
              >
                <Icon name="magnifying-glass" size="small" class="shrink-0 text-text-weak" />
                <span class="truncate text-text-base">{entry.url}</span>
                <Show when={entry.title}>
                  <span class="ml-auto shrink-0 text-12-regular text-text-weak">{entry.title}</span>
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
 *
 * For v1 the inline drawer is still a lightweight tail; users who want the
 * full Chromium DevTools surface should click "Open DevTools" from the
 * overflow menu.
 */
function BrowserPaneConsoleDrawer() {
  const ctx = useBrowserPane()
  const hasEntries = () => ctx.consoleEntries().length > 0
  return (
    <div
      classList={{
        "flex flex-col border-t border-border-weak-base bg-background-base": true,
        hidden: !ctx.consoleDrawerOpen(),
      }}
      data-testid="browser-pane-console-drawer"
      style={{ "max-height": "40%", "min-height": "120px" }}
    >
      <div class="flex h-8 shrink-0 items-center justify-between border-b border-border-weak-base px-2">
        <div class="flex items-center gap-2 text-12-medium text-text-base">
          <Icon name="console" size="small" class="text-text-weak" />
          <span>Console</span>
          <span class="text-text-weak tabular-nums">{ctx.consoleEntries().length}</span>
        </div>
        <div class="flex items-center gap-0.5">
          <Tooltip value="Open Chromium DevTools" placement="bottom">
            <IconButton
              icon="square-arrow-top-right"
              variant="ghost"
              size="small"
              aria-label="Open DevTools"
              onClick={() => void ctx.openDevTools()}
              data-testid="browser-pane-console-open-devtools"
            />
          </Tooltip>
          <Tooltip value="Clear console" placement="bottom">
            <IconButton
              icon="close-small"
              variant="ghost"
              size="small"
              aria-label="Clear console"
              disabled={!hasEntries()}
              onClick={() => ctx.clearConsole()}
              data-testid="browser-pane-console-clear"
            />
          </Tooltip>
        </div>
      </div>
      <Show
        when={hasEntries()}
        fallback={
          <div class="flex flex-1 items-center justify-center px-3 py-4 text-12-regular text-text-weak">
            No console output yet.
          </div>
        }
      >
        <ul class="flex-1 overflow-auto divide-y divide-border-weak-base">
          <For each={ctx.consoleEntries()}>
            {(entry) => (
              <li class="flex items-start gap-2 px-2 py-1 text-12-mono">
                <span
                  class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  classList={{
                    "bg-surface-critical-strong": entry.level === "error",
                    "bg-surface-warning-strong": entry.level === "warn",
                    "bg-text-weak": entry.level === "debug" || entry.level === "info",
                    "bg-text-base": entry.level === "log",
                  }}
                  aria-hidden="true"
                />
                <span
                  class="w-12 shrink-0 text-12-medium uppercase tracking-wider"
                  classList={{
                    "text-surface-critical-strong": entry.level === "error",
                    "text-surface-warning-strong": entry.level === "warn",
                    "text-text-weak": entry.level === "debug" || entry.level === "info",
                    "text-text-base": entry.level === "log",
                  }}
                >
                  {entry.level}
                </span>
                <span class="flex-1 whitespace-pre-wrap break-words text-text-base">{entry.args.join(" ")}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
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
  tabId?: string
  initialUrl?: string
  api: BrowserBridgeApi
  browserId?: string
  history?: BrowserHistoryState
  onNavigationChange?: (patch: { currentUrl?: string; pageTitle?: string }) => void
  onPageComment?: (payload: BrowserPaneCommentPayload) => boolean
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
        return
      }
      // Registration succeeded — refresh nav state so the toolbar enables
      // back/forward buttons appropriately.
      void ctx.refreshNavigationState()
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
    // Navigating invalidates any picked element — the DOM the user was
    // annotating no longer exists. Clear the selection so the floating card
    // (and any open composer) dismiss with the page.
    ctx.clearLastSelectedNode()
    // After a navigation completes, canGoBack/canGoForward may flip.
    void ctx.refreshNavigationState()
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

  /**
   * Handle `ipc-message` events from the guest. The react-grab preload
   * calls `ipcRenderer.sendToHost("claxedo-browser-pick", payload)` when
   * the user picks an element with the overlay; Electron surfaces that on
   * the `<webview>` element as `ipc-message` with `{ channel, args }`.
   * We translate the guest payload into the renderer's
   * `BrowserNodeSelectedPayload` shape and push it onto the pane context
   * so the existing floating-card + composer + session-routing pipeline
   * (unchanged since Unit 6) keeps working.
   *
   * We listen directly on the webview rather than going through the main
   * process because the payload originates in the same renderer
   * world-group (host renderer ← webview host) and a round-trip would
   * cost nothing visible but double the surface to maintain.
   */
  const handleGuestIpc = (e: Event & { channel?: string; args?: unknown[] }) => {
    // Surface preload diagnostics in the host console so we can see exactly
    // why the overlay isn't rendering when something breaks inside the guest.
    if (e.channel === "claxedo-preload:diag") {
      // eslint-disable-next-line no-console
      console.log("[claxedo-preload-diag]", Array.isArray(e.args) ? e.args[0] : e.args)
      return
    }
    // User submitted a comment in react-grab's inline popover. The preload
    // hooks `onCopySuccess(elements, content)` and forwards the compiled
    // prompt string (user's comment + element snippet) plus the structured
    // element payload. We hand it to the parent panel, which writes it onto
    // the focused session's prompt.context. (Old multi-pane build went
    // through pane-bus + binding; the workspace-panel always has a
    // deterministic target session, so routing is just a callback.)
    if (e.channel === "claxedo-browser-comment-submit") {
      const raw = (Array.isArray(e.args) ? e.args[0] : undefined) as
        | (GuestPickPayload & { content?: string })
        | undefined
      if (!raw || typeof raw !== "object") return
      const content = typeof raw.content === "string" ? raw.content : ""
      // The content is "<user comment>\n\n<element snippet>" when a comment
      // was typed. Split so we can surface the comment separately.
      const splitIdx = content.indexOf("\n\n")
      const commentText = splitIdx >= 0 ? content.slice(0, splitIdx).trim() : ""
      const payload: BrowserPaneCommentPayload = {
        tabId: props.tabId ?? "",
        pageUrl: typeof raw.frameUrl === "string" ? raw.frameUrl : ctx.currentUrl() ?? "",
        selector: typeof raw.selector === "string" ? raw.selector : "",
        comment: commentText || content,
        noteText: content,
        outerHTML: typeof raw.outerHTML === "string" ? raw.outerHTML : undefined,
        boundingBox: raw.boundingBox ?? undefined,
      }
      const routed = props.onPageComment ? props.onPageComment(payload) : false
      if (routed) {
        showToast({ title: "Comment sent to session", variant: "success", duration: 2000 })
      } else if (props.onPageComment) {
        showToast({ title: "No session focused — comment saved locally", variant: "default", duration: 3000 })
      }
      void ctx.setInspectMode(false)
      return
    }
    if (e.channel !== "claxedo-browser-pick") return
    const raw = (Array.isArray(e.args) ? e.args[0] : undefined) as GuestPickPayload | undefined
    if (!raw || typeof raw !== "object") return
    const payload: BrowserNodeSelectedPayload = {
      ok: true,
      selector: typeof raw.selector === "string" ? raw.selector : "",
      frameUrl: typeof raw.frameUrl === "string" ? raw.frameUrl : ctx.currentUrl() ?? "",
      tagName: typeof raw.tagName === "string" ? raw.tagName : "unknown",
      outerHTML: typeof raw.outerHTML === "string" ? raw.outerHTML : undefined,
      boundingBox: raw.boundingBox ?? undefined,
      computedStyles: raw.computedStyles ?? undefined,
    }
    // The old CDP picker auto-disabled inspect mode on the main side after
    // a click; react-grab's `onElementSelect` does the same thing in-page,
    // but the host's toggle signal doesn't know that, so we flip it off
    // ourselves. `setInspectMode(false)` routes through the context which
    // also forwards a `set-mode: off` message to the guest so react-grab
    // stays in sync if it stayed armed for any reason.
    void ctx.setInspectMode(false)
    ctx.setLastSelectedNode(payload)
  }

  onCleanup(() => {
    if (webview) {
      webview.removeEventListener("dom-ready", handleDomReady as EventListener)
      webview.removeEventListener("did-navigate", handleDidNavigate as EventListener)
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated as EventListener)
      webview.removeEventListener("ipc-message", handleGuestIpc as EventListener)
      ctx.detachWebview()
    }
    void props.api.unregister(props.paneId).catch(() => {})
  })

  const attachListeners = (el: WebviewElement) => {
    webview = el
    el.addEventListener("dom-ready", handleDomReady as EventListener)
    el.addEventListener("did-navigate", handleDidNavigate as EventListener)
    el.addEventListener("page-title-updated", handlePageTitleUpdated as EventListener)
    el.addEventListener("ipc-message", handleGuestIpc as EventListener)
    // Publish the webview to the pane context so `setInspectMode` can
    // send `claxedo-picker:set-mode` messages directly into the guest
    // preload without plumbing the ref through another layer.
    ctx.attachWebview(el)
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
