import { createSimpleContext } from "@opencode-ai/ui/context"
import { createSignal, onCleanup, type Accessor } from "solid-js"

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
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message?: string; stack?: string } }

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
    }
  | {
      ok: false
      error: "shadow-root-closed" | "element-not-found" | "not-attached" | "generic" | "timeout"
      message?: string
      frameUrl?: string
    }

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
}

export const MAX_CLIENT_CONSOLE_ENTRIES = 2000

type InitProps = {
  paneId: string
  bridge?: BrowserBridgeApi
  initialUrl?: string
}

function getDefaultBridge(): BrowserBridgeApi | undefined {
  if (typeof window === "undefined") return undefined
  const w = window as unknown as { api?: { browser?: BrowserBridgeApi } }
  return w.api?.browser
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
  clearLastSelectedNode: () => void
  clearConsole: () => void
  captureScreenshot: (opts?: { clip?: BrowserScreenshotClip }) => Promise<BrowserScreenshotResult>
  evaluate: (expression: string) => Promise<BrowserEvaluateResult>
}

export const { use: useBrowserPane, provider: BrowserPaneProvider } = createSimpleContext({
  name: "BrowserPane",
  init: (props: InitProps): BrowserPaneState => {
    const bridge = props.bridge ?? getDefaultBridge()

    const [consoleEntries, setConsoleEntries] = createSignal<BrowserConsoleEntry[]>([])
    const [consoleDrawerOpen, setConsoleDrawerOpen] = createSignal<boolean>(false)
    const [isLoading, setLoading] = createSignal<boolean>(false)
    const [currentUrl, setCurrentUrl] = createSignal<string | undefined>(props.initialUrl)
    const [agentAllowed, setAgentAllowedSig] = createSignal<boolean>(false)
    const [inspectMode, setInspectModeSig] = createSignal<boolean>(false)
    const [lastSelectedNode, setLastSelectedNode] = createSignal<BrowserNodeSelectedPayload | undefined>(undefined)

    const appendEntry = (e: BrowserConsoleEntry) => {
      const arr = consoleEntries()
      const next = arr.length >= MAX_CLIENT_CONSOLE_ENTRIES ? arr.slice(arr.length - MAX_CLIENT_CONSOLE_ENTRIES + 1) : arr.slice()
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

      // Node-selected subscription. Chromium auto-disables inspect mode on
      // click, so the signal is flipped back here regardless of the payload.
      const unsubscribeNode = bridge.onNodeSelected(props.paneId, (payload) => {
        setInspectModeSig(false)
        setLastSelectedNode(payload)
      })
      onCleanup(() => {
        try {
          unsubscribeNode()
        } catch {
          // ignore
        }
      })
    }

    const clearConsole = () => setConsoleEntries([])

    const setAgentAllowed = async (allowed: boolean) => {
      setAgentAllowedSig(Boolean(allowed))
      if (bridge) {
        try {
          await bridge.setAgentAllowed(props.paneId, Boolean(allowed))
        } catch {
          // Revert on failure so UI is never out of sync with main.
          setAgentAllowedSig((v) => !v)
        }
      }
    }

    const captureScreenshot = async (
      opts?: { clip?: BrowserScreenshotClip },
    ): Promise<BrowserScreenshotResult> => {
      if (!bridge) return { ok: false, error: { code: "no-bridge", message: "Browser bridge unavailable" } }
      return bridge.captureScreenshot(props.paneId, opts)
    }

    const evaluate = async (expression: string): Promise<BrowserEvaluateResult> => {
      if (!bridge) return { ok: false, error: { code: "no-bridge", message: "Browser bridge unavailable" } }
      return bridge.evaluate(props.paneId, expression)
    }

    const setInspectMode = async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
      if (!bridge) return { ok: false, error: "no-bridge" }
      // Optimistically flip the UI signal; revert if the main process
      // refuses. This keeps the button feedback snappy.
      setInspectModeSig(Boolean(enabled))
      try {
        const r = await bridge.setInspectMode(props.paneId, Boolean(enabled))
        if (!r.ok) {
          setInspectModeSig(!enabled)
          return r
        }
        return r
      } catch (err) {
        setInspectModeSig(!enabled)
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const clearLastSelectedNode = () => setLastSelectedNode(undefined)

    return {
      paneId: () => props.paneId,
      bridge: () => bridge,
      consoleEntries,
      consoleDrawerOpen,
      setConsoleDrawerOpen: (v: boolean) => setConsoleDrawerOpen(Boolean(v)),
      isLoading,
      setLoading: (v: boolean) => setLoading(Boolean(v)),
      currentUrl,
      setCurrentUrl,
      agentAllowed,
      setAgentAllowed,
      inspectMode,
      setInspectMode,
      lastSelectedNode,
      clearLastSelectedNode,
      clearConsole,
      captureScreenshot,
      evaluate,
    }
  },
})
