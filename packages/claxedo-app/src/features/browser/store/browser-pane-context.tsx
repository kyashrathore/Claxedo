import { createSimpleContext } from "@opencode-ai/ui/context"
import { createSignal, onCleanup, untrack, type Accessor } from "solid-js"

/**
 * BrowserPaneContext.
 *
 * Wraps the main-process `window.api.browser` bridge for a single paneId and
 * exposes SolidJS signals that the renderer can subscribe to:
 *
 *   - `consoleEntries` — live-tailing ring of entries streamed from main
 *   - `isLoading` — best-effort reflection of dom-ready / navigation state
 *   - `currentUrl` — last known URL for the pane
 *   - `agentAllowed` — per-tab opt-in gate for agent-side `evaluate`
 *
 * Follows the pane-local-frontend-orchestration layer direction (code lives
 * under `packages/claxedo-app/src/browser/`, not inside `claxedo-ui`).
 *
 * The provider MUST be mounted directly inside the pane tree — `createSignal`
 * ownership matters in SolidJS and wrapProviders evaluation breaks the chain.
 */

export type BrowserConsoleLevel = "log" | "warn" | "error" | "debug" | "info"

export type BrowserConsoleStackFrame = {
  url?: string
  function?: string
  line?: number
  column?: number
}

export type BrowserConsoleEntry = {
  id: number
  time: number
  level: BrowserConsoleLevel
  args: string[]
  stack?: BrowserConsoleStackFrame[]
  source: "console" | "exception" | "log"
  sessionId?: string
}

export type BrowserScreenshotClip = {
  x: number
  y: number
  width: number
  height: number
  scale?: number
}

export type BrowserScreenshotResult =
  | { ok: true; dataUrl: string; mimeType: "image/png" | "image/jpeg" }
  | { ok: false; error: { code: string; message?: string } }

export type BrowserEvaluateResult =
  { ok: true; result: unknown } | { ok: false; error: { code: string; message?: string; stack?: string } }

/** Renderer-mirror of the main-process `NodeSelectedPayload`. */
export type BrowserNodeSelectedPayload =
  | {
      ok: true
      selector: string
      shadow?: { host: string; inner: string }
      frameUrl: string
      boundingBox?: { x: number; y: number; width: number; height: number }
      outerHTML?: string
      tagName: string
      screenshotDataUrl?: string
      /**
       * Mirror of the main-process computed styles snapshot. All properties
       * are independently optional so the renderer's floating element-info
       * card can degrade gracefully when the CSS domain wasn't ready or the
       * DOM detached before the computed styles round-trip landed.
       */
      computedStyles?: {
        color?: string
        backgroundColor?: string
        fontFamily?: string
        fontSize?: string
        display?: string
      }
    }
  | {
      ok: false
      error: "shadow-root-closed" | "element-not-found" | "not-attached" | "generic" | "timeout" | "canceled"
      message?: string
      frameUrl?: string
    }

export type BrowserStorageKey = "cookies" | "localstorage" | "indexdb" | "cachestorage" | "serviceworkers"

export type BrowserNavigationState =
  { ok: true; url: string; canGoBack: boolean; canGoForward: boolean } | { ok: false; error: string }

export type BrowserBridgeApi = {
  enabled: () => Promise<boolean>
  register: (paneId: string, webContentsId: number) => Promise<{ ok: boolean; error?: string }>
  unregister: (paneId: string) => Promise<{ ok: boolean; error?: string }>
  navigate: (paneId: string, url: string) => Promise<{ ok: boolean; error?: string }>
  getConsoleLogs: (
    paneId: string,
    q?: { since?: number; level?: BrowserConsoleLevel; limit?: number },
  ) => Promise<BrowserConsoleEntry[]>
  onConsoleEntry: (paneId: string, cb: (e: BrowserConsoleEntry) => void) => () => void
  captureScreenshot: (paneId: string, opts?: { clip?: BrowserScreenshotClip }) => Promise<BrowserScreenshotResult>
  evaluate: (paneId: string, expression: string) => Promise<BrowserEvaluateResult>
  setAgentAllowed: (paneId: string, allowed: boolean) => Promise<{ ok: boolean; error?: string }>
  setInspectMode: (paneId: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  onNodeSelected: (paneId: string, cb: (payload: BrowserNodeSelectedPayload) => void) => () => void
  /** Toolbar primitives — all optional so the renderer degrades gracefully if
   * the preload build is older than the renderer. */
  getNavigationState?: (paneId: string) => Promise<BrowserNavigationState>
  goBack?: (paneId: string) => Promise<{ ok: boolean; error?: string }>
  goForward?: (paneId: string) => Promise<{ ok: boolean; error?: string }>
  reload?: (paneId: string, hard?: boolean) => Promise<{ ok: boolean; error?: string }>
  openDevTools?: (paneId: string) => Promise<{ ok: boolean; error?: string }>
  clearStorage?: (paneId: string, storages?: BrowserStorageKey[]) => Promise<{ ok: boolean; error?: string }>
}

export const MAX_CLIENT_CONSOLE_ENTRIES = 2000

type InitProps = {
  paneId: string
  bridge?: BrowserBridgeApi
  initialUrl?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function isBrowserBridgeApi(value: unknown): value is BrowserBridgeApi {
  if (!isRecord(value)) return false
  return (
    typeof value.enabled === "function" &&
    typeof value.register === "function" &&
    typeof value.unregister === "function" &&
    typeof value.navigate === "function" &&
    typeof value.getConsoleLogs === "function" &&
    typeof value.onConsoleEntry === "function" &&
    typeof value.captureScreenshot === "function" &&
    typeof value.evaluate === "function" &&
    typeof value.setAgentAllowed === "function" &&
    typeof value.setInspectMode === "function" &&
    typeof value.onNodeSelected === "function"
  )
}

export function getDefaultBrowserBridge(): BrowserBridgeApi | undefined {
  if (typeof window === "undefined") return undefined
  if (!("api" in window)) return undefined
  const api: unknown = window.api
  if (!isRecord(api)) return undefined
  return isBrowserBridgeApi(api.browser) ? api.browser : undefined
}

/**
 * Minimal shape of the Electron `<webview>` element surface we need to pipe
 * host→guest messages (picker set-mode) to the guest preload. We don't
 * import Electron's `WebviewTag` type because tests run in a browser-like
 * environment where it's unavailable; only two methods matter here.
 */
export type WebviewRef = HTMLElement & {
  send?: (channel: string, ...args: unknown[]) => void
}

export type BrowserPaneState = {
  paneId: Accessor<string>
  bridge: Accessor<BrowserBridgeApi | undefined>
  consoleEntries: Accessor<BrowserConsoleEntry[]>
  consoleDrawerOpen: Accessor<boolean>
  setConsoleDrawerOpen: (v: boolean) => void
  isLoading: Accessor<boolean>
  setLoading: (v: boolean) => void
  currentUrl: Accessor<string | undefined>
  setCurrentUrl: (url: string | undefined) => void
  agentAllowed: Accessor<boolean>
  setAgentAllowed: (allowed: boolean) => Promise<void>
  inspectMode: Accessor<boolean>
  setInspectMode: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  lastSelectedNode: Accessor<BrowserNodeSelectedPayload | undefined>
  /** Publish a node-selected payload (used by the guest `ipc-message` path). */
  setLastSelectedNode: (payload: BrowserNodeSelectedPayload | undefined) => void
  clearLastSelectedNode: () => void
  clearConsole: () => void
  captureScreenshot: (opts?: { clip?: BrowserScreenshotClip }) => Promise<BrowserScreenshotResult>
  evaluate: (expression: string) => Promise<BrowserEvaluateResult>
  /**
   * Attach / detach the live `<webview>` DOM ref so the context can forward
   * picker `set-mode` messages into the guest preload. Called by
   * `WebviewHost`'s ref callback / onCleanup hooks.
   */
  attachWebview: (ref: WebviewRef) => void
  detachWebview: () => void
  /** Navigation state — sourced from the main-process handle via
   * `getNavigationState` and refreshed on `did-navigate`. */
  canGoBack: Accessor<boolean>
  canGoForward: Accessor<boolean>
  refreshNavigationState: () => Promise<void>
  goBack: () => Promise<{ ok: boolean; error?: string }>
  goForward: () => Promise<{ ok: boolean; error?: string }>
  reload: (hard?: boolean) => Promise<{ ok: boolean; error?: string }>
  openDevTools: () => Promise<{ ok: boolean; error?: string }>
  clearCookies: () => Promise<{ ok: boolean; error?: string }>
}

const browserPaneContextInput = {
  name: "BrowserPane",
  gate: true,
  init: (props: InitProps): BrowserPaneState => {
    const bridge = props.bridge ?? getDefaultBrowserBridge()

    const [consoleEntries, setConsoleEntries] = createSignal<BrowserConsoleEntry[]>([])
    const [consoleDrawerOpen, setConsoleDrawerOpen] = createSignal(false)
    const [isLoading, setLoading] = createSignal(false)
    const [currentUrl, setCurrentUrl] = createSignal(props.initialUrl)
    const [agentAllowed, setAgentAllowedSig] = createSignal(false)
    const [inspectMode, setInspectModeSig] = createSignal(false)
    const [lastSelectedNode, setLastSelectedNode] = createSignal<BrowserNodeSelectedPayload>()

    const appendEntry = (e: BrowserConsoleEntry) => {
      const arr = consoleEntries()
      const next =
        arr.length >= MAX_CLIENT_CONSOLE_ENTRIES ? arr.slice(arr.length - MAX_CLIENT_CONSOLE_ENTRIES + 1) : arr.slice()
      next.push(e)
      setConsoleEntries(next)
    }

    if (bridge) {
      // Live stream — retained in the signal for the drawer.
      const unsubscribe = bridge.onConsoleEntry(props.paneId, appendEntry)
      onCleanup(() => {
        try {
          unsubscribe()
        } catch {
          // ignore
        }
      })
    }
    // Node-selected payloads no longer arrive through `bridge.onNodeSelected`
    // — the picker has moved from CDP in the main process to an in-page
    // react-grab overlay loaded via the guest preload, and the payload is
    // routed by `WebviewHost`'s `ipc-message` listener calling
    // `setLastSelectedNode(...)` directly. The bridge method is kept on
    // `BrowserBridgeApi` as a typed no-op for compatibility with any
    // external consumer that still references it.

    const clearConsole = () => setConsoleEntries([])

    const setAgentAllowed = async (allowed: boolean) => {
      setAgentAllowedSig(allowed)
      if (bridge) {
        try {
          await bridge.setAgentAllowed(props.paneId, allowed)
        } catch {
          // Revert on failure so UI is never out of sync with main.
          setAgentAllowedSig((v) => !v)
        }
      }
    }

    const captureScreenshot = async (opts?: { clip?: BrowserScreenshotClip }): Promise<BrowserScreenshotResult> => {
      if (!bridge) return { ok: false, error: { code: "no-bridge", message: "Browser bridge unavailable" } }
      return bridge.captureScreenshot(props.paneId, opts)
    }

    const evaluate = async (expression: string): Promise<BrowserEvaluateResult> => {
      if (!bridge) return { ok: false, error: { code: "no-bridge", message: "Browser bridge unavailable" } }
      return bridge.evaluate(props.paneId, expression)
    }

    let webviewRef: WebviewRef | undefined
    const attachWebview = (ref: WebviewRef) => {
      webviewRef = ref
    }
    const detachWebview = () => {
      webviewRef = undefined
    }

    const setInspectMode = async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      // The picker now lives in-page (react-grab in the guest preload) —
      // we talk to it via webview-direct IPC rather than the old
      // main-process CDP path. Flip the UI signal optimistically so the
      // Inspect button stays snappy; there is no async confirmation step
      // anymore, the guest simply acts on the message.
      setInspectModeSig(enabled)
      if (webviewRef && typeof webviewRef.send === "function") {
        try {
          webviewRef.send("claxedo-picker:set-mode", enabled ? "comment" : "off")
        } catch (err) {
          // If the guest isn't reachable (mid-attach, crashed page) the
          // signal is already toggled — next attempt will retry.
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        return { ok: true }
      }
      // No webview attached yet (tests, fallback UI). Keep the signal
      // in-sync with the caller's intent so subsequent attach() picks it up.
      return { ok: false, error: "no-webview" }
    }

    const clearLastSelectedNode = () => setLastSelectedNode(undefined)

    const [canGoBack, setCanGoBack] = createSignal(false)
    const [canGoForward, setCanGoForward] = createSignal(false)

    const refreshNavigationState = async () => {
      if (!bridge?.getNavigationState) return
      try {
        const res = await bridge.getNavigationState(props.paneId)
        if (res.ok) {
          setCanGoBack(res.canGoBack)
          setCanGoForward(res.canGoForward)
          if (res.url && res.url.length > 0) setCurrentUrl(res.url)
        }
      } catch {
        // The pane may not yet be registered — silently ignore; next nav
        // will retry.
      }
    }

    const goBack = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!bridge?.goBack) return { ok: false, error: "no-bridge" }
      const r = await bridge.goBack(props.paneId)
      void refreshNavigationState()
      return r
    }
    const goForward = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!bridge?.goForward) return { ok: false, error: "no-bridge" }
      const r = await bridge.goForward(props.paneId)
      void refreshNavigationState()
      return r
    }
    const reload = async (hard = false): Promise<{ ok: boolean; error?: string }> => {
      if (!bridge?.reload) return { ok: false, error: "no-bridge" }
      const r = await bridge.reload(props.paneId, hard)
      void refreshNavigationState()
      return r
    }
    const openDevTools = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!bridge?.openDevTools) return { ok: false, error: "no-bridge" }
      return bridge.openDevTools(props.paneId)
    }
    const clearCookies = async (): Promise<{ ok: boolean; error?: string }> => {
      if (!bridge?.clearStorage) return { ok: false, error: "no-bridge" }
      return bridge.clearStorage(props.paneId, ["cookies"])
    }

    return {
      paneId: () => props.paneId,
      bridge: () => bridge,
      consoleEntries,
      consoleDrawerOpen,
      setConsoleDrawerOpen: (v: boolean) => setConsoleDrawerOpen(v),
      isLoading,
      setLoading: (v: boolean) => setLoading(v),
      currentUrl,
      setCurrentUrl,
      agentAllowed,
      setAgentAllowed,
      inspectMode,
      setInspectMode,
      lastSelectedNode,
      setLastSelectedNode: (payload) => setLastSelectedNode(payload),
      clearLastSelectedNode,
      clearConsole,
      captureScreenshot,
      evaluate,
      attachWebview,
      detachWebview,
      canGoBack,
      canGoForward,
      refreshNavigationState,
      goBack,
      goForward,
      reload,
      openDevTools,
      clearCookies,
    }
  },
}
const browserPaneContext = createSimpleContext<ReturnType<typeof browserPaneContextInput.init>, InitProps>(
  browserPaneContextInput,
)

export function useBrowserPane() {
  return browserPaneContext.use()
}

export const BrowserPaneProvider = browserPaneContext.provider
