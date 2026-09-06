/**
 * BrowserHandle — main-process wrapper around a single agent-browser
 * `<webview>`'s `webContents`. Owns the CDP attach state machine, streams
 * console entries into a ring buffer, and exposes `screenshot`, `evaluate`,
 * and `getConsoleLogs` for the IPC layer to call through.
 *
 * CDP attach state machine:
 *
 *   Detached → Attaching → Attached → Reattaching → Attached
 *
 *   - `dom-ready` (first time or after crash) →
 *       debugger.attach("1.3")
 *       + Target.setAutoAttach({ flatten: true, waitForDebuggerOnStart: false })
 *       + enable Runtime / Page / Log on the top session
 *   - `did-navigate` (main-frame only) → re-enable domains + re-subscribe
 *     Target.setAutoAttach. Cross-origin navigation swaps the RenderFrameHost;
 *     the enable is cheap and keeps Runtime events flowing on the new RFH.
 *   - `render-process-gone` → clear subs + console buffer; reattach on next
 *     `dom-ready`.
 *   - debugger `"detach"` event (fires when user opens DevTools: reason
 *     `"canceled by user"`) → mark Detached; reattach on `devtools-closed`.
 *   - `destroyed` → `try { detach() } catch {}` and drop listeners.
 *
 * Screenshot and evaluate are plain CDP round-trips. Evaluate is gated on
 * `agentAllowed`, enforced *here* (main process) so UI-only toggles can't be
 * worked around by calling the IPC directly.
 *
 * Tests live in `handle.test.ts` and use a `makeFakeWc()` factory — this file
 * must therefore talk to `webContents` only through the minimal surface the
 * fake can stub, with no direct `electron`-package calls at runtime.
 */

import type { Event, RenderProcessGoneDetails, WebContents } from "electron"

import {
  AgentAuditLog,
  agentAuditLog as defaultAgentAuditLog,
  type AgentAuditAction,
  type AgentAuditResult,
} from "./agent-audit-log"
import {
  ConsoleBuffer,
  type ConsoleEntry,
  type ConsoleLevel,
  type ConsoleQuery,
  type ConsoleStackFrame,
} from "./console-buffer"
import { isRecord, readArray, readNumber, readRecord, readString, readUnknown } from "../../shared/json-read"

export type BrowserHandleState = "detached" | "attaching" | "attached" | "reattaching"

const CDP_PROTOCOL_VERSION = "1.3"
// Runtime/Page/Log back console/exception streaming and navigation-state
// polling. The element picker is an in-page overlay loaded by the guest preload
// (`browser-preload/index.ts`), so Overlay/DOM/CSS are not enabled.
const ENABLED_DOMAINS = ["Runtime", "Page", "Log"] as const

const SIZE_LIMIT_BYTES = 1_000_000
const DOWNSCALE_LONG_EDGE = 1920
const JPEG_QUALITY = 80

export type ScreenshotClip = { x: number; y: number; width: number; height: number; scale?: number }
export type ScreenshotOptions = { clip?: ScreenshotClip }

export type ScreenshotSuccess = { ok: true; dataUrl: string; mimeType: "image/png" | "image/jpeg" }
export type ScreenshotFailure = { ok: false; error: { code: "no-page" | "not-attached" | "cdp-error"; message?: string } }
export type ScreenshotResult = ScreenshotSuccess | ScreenshotFailure

export type EvaluateSuccess = { ok: true; result: unknown }
export type EvaluateFailure = {
  ok: false
  error: { code: "eval-denied" | "not-attached" | "cdp-error" | "script-error"; message?: string; stack?: string }
}
export type EvaluateResult = EvaluateSuccess | EvaluateFailure

export type ConsoleEntryListener = (entry: ConsoleEntry) => void

/**
 * The preload bridge's `BrowserNodeSelectedPayload`. The in-page picker
 * delivers these to the renderer over the `<webview>`'s `ipc-message` channel;
 * nothing in this handle emits one, and `onNodeSelected` is a typed no-op.
 */
export type NodeSelectedPayload =
  | {
      ok: true
      selector: string
      shadow?: { host: string; inner: string }
      frameUrl: string
      boundingBox?: { x: number; y: number; width: number; height: number }
      outerHTML?: string
      tagName: string
      screenshotDataUrl?: string
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

export type NodeSelectedListener = (payload: NodeSelectedPayload) => void

/**
 * The subset of Electron's `WebContents` the handle touches, including the
 * toolbar's navigation and DevTools calls, so `handle.test.ts` can stub it
 * without standing up Electron.
 */
export type BrowserWc = Pick<
  WebContents,
  | "id"
  | "isDestroyed"
  | "loadURL"
  | "getURL"
  | "getTitle"
  | "canGoBack"
  | "canGoForward"
  | "goBack"
  | "goForward"
  | "reload"
  | "reloadIgnoringCache"
  | "openDevTools"
  | "closeDevTools"
  | "isDevToolsOpened"
> &
  BrowserWcEvents & {
    debugger: BrowserDebugger
    session?: {
      clearStorageData?: WebContents["session"]["clearStorageData"]
    }
  }

/**
 * The `webContents` events the handle subscribes to, spelled out with the
 * signatures Electron actually emits them with.
 *
 * `Pick<WebContents, "on" | "off">` drags in ~70 overloads, so every
 * `wc.on(event, handler)` call here used to need a cast to silence overload
 * resolution — which is how `did-navigate` came to be handled with a fifth
 * `isMainFrame` parameter Electron never passes. Declaring only the five
 * events this class uses makes the handlers type-checked against reality.
 */
export type BrowserWcEvents = {
  on(event: "dom-ready" | "devtools-closed" | "destroyed", listener: () => void): unknown
  on(
    event: "did-navigate",
    listener: (event: Event, url: string, httpResponseCode: number, httpStatusText: string) => void,
  ): unknown
  on(event: "render-process-gone", listener: (event: Event, details: RenderProcessGoneDetails) => void): unknown
  off(event: "dom-ready" | "devtools-closed" | "destroyed", listener: () => void): unknown
  off(
    event: "did-navigate",
    listener: (event: Event, url: string, httpResponseCode: number, httpStatusText: string) => void,
  ): unknown
  off(event: "render-process-gone", listener: (event: Event, details: RenderProcessGoneDetails) => void): unknown
}

export type BrowserDebugger = {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, commandParams?: unknown, sessionId?: string): Promise<unknown>
  on(event: "detach", listener: (event: Event, reason: string) => void): unknown
  on(event: "message", listener: (event: Event, method: string, params: unknown, sessionId: string) => void): unknown
  off(event: "detach", listener: (event: Event, reason: string) => void): unknown
  off(event: "message", listener: (event: Event, method: string, params: unknown, sessionId: string) => void): unknown
}

export type BrowserHandleOptions = {
  auditLog?: AgentAuditLog
  /** Override for tests — default is an in-process PNG→JPEG recompressor no-op. */
  recompress?: RecompressFn
}

export type RecompressFn = (
  pngBase64: string,
  opts: { toJpegQuality?: number; maxLongEdge?: number },
) => Promise<{ mimeType: "image/png" | "image/jpeg"; base64: string }>

/**
 * Default recompressor — in a real Electron run we'd shell out to
 * `nativeImage` or `sharp`. Neither is available in unit tests, so the
 * default is a conservative passthrough that reports the PNG unchanged; the
 * caller's size-cap decision still fires and tests can inject a real
 * recompressor as needed.
 */
const passthroughRecompress: RecompressFn = async (pngBase64) => ({ mimeType: "image/png", base64: pngBase64 })

export class BrowserHandle {
  #wc: BrowserWc
  #state: BrowserHandleState = "detached"
  #console = new ConsoleBuffer()
  #listeners: Set<ConsoleEntryListener> = new Set()
  #agentAllowed = false
  #auditLog: AgentAuditLog
  #recompress: RecompressFn

  /** Child sessions discovered via Target.attachedToTarget (flat mode). */
  #childSessionIds: Set<string> = new Set()

  // Retained references so wc event handlers can be removed on destroy.
  #onDomReady: () => void
  #onDidNavigate: () => void
  #onRenderProcessGone: () => void
  #onDevtoolsClosed: () => void
  #onWcDestroyed: () => void
  #onDebuggerDetach: () => void
  #onDebuggerMessage: (event: Event, method: string, params: unknown, sessionId: string) => void

  constructor(wc: BrowserWc, opts: BrowserHandleOptions = {}) {
    this.#wc = wc
    this.#auditLog = opts.auditLog ?? defaultAgentAuditLog
    this.#recompress = opts.recompress ?? passthroughRecompress

    this.#onDomReady = () => {
      void this.#handleDomReady()
    }
    this.#onDidNavigate = () => {
      // Electron emits `did-navigate` for main-frame navigations only
      // (`did-frame-navigate` is the any-frame variant), so every one of
      // these swapped the RFH.
      void this.#handleMainFrameNavigated()
    }
    this.#onRenderProcessGone = () => {
      this.#handleRenderProcessGone()
    }
    this.#onDevtoolsClosed = () => {
      // DevTools had detached our debugger; reattach best-effort.
      void this.#handleDomReady()
    }
    this.#onWcDestroyed = () => {
      this.dispose()
    }
    this.#onDebuggerDetach = () => {
      // Fires when DevTools open or WC closes. Mark Detached; reattach on
      // `devtools-closed` or `dom-ready`. If the WC is gone we'll clean up
      // through the `destroyed` event path.
      this.#state = "detached"
      this.#childSessionIds.clear()
    }
    this.#onDebuggerMessage = (_event, method, params, sessionId) => {
      this.#handleDebuggerMessage(method, params, sessionId)
    }

    // Subscribe — listeners are removed in dispose().
    this.#wc.on("dom-ready", this.#onDomReady)
    this.#wc.on("did-navigate", this.#onDidNavigate)
    this.#wc.on("render-process-gone", this.#onRenderProcessGone)
    this.#wc.on("devtools-closed", this.#onDevtoolsClosed)
    this.#wc.on("destroyed", this.#onWcDestroyed)
    this.#wc.debugger.on("detach", this.#onDebuggerDetach)
    this.#wc.debugger.on("message", this.#onDebuggerMessage)
  }

  get webContentsId(): number {
    return this.#wc.id
  }
  get state(): BrowserHandleState {
    return this.#state
  }
  get agentAllowed(): boolean {
    return this.#agentAllowed
  }
  /** Exposed for tests and IPC diagnostics. */
  get consoleBuffer(): ConsoleBuffer {
    return this.#console
  }

  setAgentAllowed(allowed: boolean): void {
    this.#agentAllowed = allowed
  }

  /**
   * Typed no-op. The renderer drives picker mode over the `<webview>`'s IPC
   * channel (`claxedo-picker:set-mode`); this answers `{ ok: true }` with no
   * CDP round-trip.
   */
  async setInspectMode(_enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: true }
  }

  /**
   * Typed no-op: the picker emits its payload over the `<webview>`'s
   * `ipc-message` channel directly to the renderer, so nothing ever fires here.
   */
  onNodeSelected(_cb: NodeSelectedListener): () => void {
    return () => {}
  }

  /**
   * Manually trigger the attach path — useful when the handle is created
   * *after* `dom-ready` fired (e.g. race between webview load and paneId
   * registration). The dom-ready listener will also drive this naturally.
   */
  async attach(): Promise<void> {
    await this.#handleDomReady()
  }

  /** Detach best-effort + drop listeners + clear buffer. Idempotent. */
  detach(): void {
    try {
      if (this.#wc.debugger.isAttached()) this.#wc.debugger.detach()
    } catch {
      // Already detached or webContents destroyed — nothing to do.
    }
    this.#state = "detached"
    this.#childSessionIds.clear()
  }

  dispose(): void {
    try {
      this.#wc.off("dom-ready", this.#onDomReady)
      this.#wc.off("did-navigate", this.#onDidNavigate)
      this.#wc.off("render-process-gone", this.#onRenderProcessGone)
      this.#wc.off("devtools-closed", this.#onDevtoolsClosed)
      this.#wc.off("destroyed", this.#onWcDestroyed)
      this.#wc.debugger.off("detach", this.#onDebuggerDetach)
      this.#wc.debugger.off("message", this.#onDebuggerMessage)
    } catch {
      // webContents may already be destroyed.
    }
    this.detach()
    this.#listeners.clear()
    this.#console.clear()
  }

  async navigate(url: string): Promise<void> {
    if (this.#wc.isDestroyed()) {
      throw new Error("webContents has been destroyed")
    }
    await this.#wc.loadURL(url)
  }

  // ─── Navigation / DevTools / Storage (toolbar-driven) ──────────────────────
  //
  // These are thin wrappers around `WebContents` calls. They exist so the IPC
  // layer has one place to route toolbar actions and `handle.test.ts` can stub
  // the minimal surface via `BrowserWc`.

  /**
   * Returns the current URL and whether back/forward are available. Callers
   * poll this after `did-navigate` so the toolbar can reflect the guest's
   * real history state without holding a separate signal on the main side.
   */
  getNavigationState(): { url: string; canGoBack: boolean; canGoForward: boolean } {
    let url = ""
    try {
      url = this.#wc.getURL() ?? ""
    } catch {
      // webContents may have been destroyed mid-call
    }
    let canGoBack = false
    let canGoForward = false
    try {
      canGoBack = this.#wc.canGoBack()
      canGoForward = this.#wc.canGoForward()
    } catch {
      // ignore — destroyed / race
    }
    return { url, canGoBack, canGoForward }
  }

  /**
   * The guest's current document title, or `""` when the `webContents` has
   * been destroyed. Paired with `getNavigationState().url` this is everything
   * the HTTP bridge's tab listing needs, so callers never need the raw
   * `WebContents`.
   */
  getTitle(): string {
    try {
      return this.#wc.getTitle() ?? ""
    } catch {
      // webContents may have been destroyed mid-call
      return ""
    }
  }

  goBack(): { ok: true } | { ok: false; error: string } {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" }
    try {
      if (!this.#wc.canGoBack()) return { ok: false, error: "no-history" }
      this.#wc.goBack()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  goForward(): { ok: true } | { ok: false; error: string } {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" }
    try {
      if (!this.#wc.canGoForward()) return { ok: false, error: "no-history" }
      this.#wc.goForward()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  reload(hard = false): { ok: true } | { ok: false; error: string } {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" }
    try {
      if (hard) this.#wc.reloadIgnoringCache()
      else this.#wc.reload()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  /**
   * Open Chromium DevTools for the guest in a detached window. This gives
   * the user the full Console / Network / Elements surface rather than only
   * our inline drawer. Opening DevTools will trigger `debugger.detach` — the
   * handle's existing detach listener already copes, and we reattach on
   * `devtools-closed`.
   */
  openDevTools(mode: "detach" | "right" | "bottom" | "undocked" = "detach"): { ok: true } | { ok: false; error: string } {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" }
    try {
      this.#wc.openDevTools({ mode })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  /**
   * Clear the `persist:agent-browser` session's storage. Defaults to cookies
   * only; callers may broaden the list via `storages`. Returns `ok: false`
   * if the underlying electron session isn't exposed on the fake.
   */
  async clearStorage(
    storages: Array<"cookies" | "localstorage" | "indexdb" | "cachestorage" | "serviceworkers"> = ["cookies"],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const sess = this.#wc.session
    if (!sess || typeof sess.clearStorageData !== "function") {
      return { ok: false, error: "no-session" }
    }
    try {
      await sess.clearStorageData({ storages })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  // ─── Console ──────────────────────────────────────────────────────────────

  getConsoleLogs(q: ConsoleQuery = {}): ConsoleEntry[] {
    return this.#console.query(q)
  }

  onConsoleEntry(cb: ConsoleEntryListener): () => void {
    this.#listeners.add(cb)
    return () => this.#listeners.delete(cb)
  }

  // ─── Screenshot ───────────────────────────────────────────────────────────

  async screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    if (this.#state !== "attached") {
      return { ok: false, error: { code: "not-attached" } }
    }
    // `about:blank` returns a valid PNG but it's useless and callers should
    // get a structured signal rather than an opaque ~85-byte data URL.
    let currentUrl = ""
    try {
      currentUrl = this.#wc.getURL() ?? ""
    } catch {
      // ignore — fall through to the CDP call
    }
    if (currentUrl === "" || currentUrl === "about:blank") {
      return { ok: false, error: { code: "no-page" } }
    }

    let pngBase64: string
    try {
      const params: Record<string, unknown> = {
        format: "png",
        captureBeyondViewport: false,
      }
      if (opts.clip) params.clip = { ...opts.clip, scale: opts.clip.scale ?? 1 }
      const data = readString(await this.#wc.debugger.sendCommand("Page.captureScreenshot", params), "data")
      if (data === undefined) {
        return { ok: false, error: { code: "cdp-error", message: "Page.captureScreenshot returned no data" } }
      }
      pngBase64 = data
    } catch (err) {
      return { ok: false, error: { code: "cdp-error", message: errMsg(err) } }
    }

    // Apply size caps. Base64 length * 0.75 ≈ byte size.
    const approxBytes = Math.floor((pngBase64.length * 3) / 4)
    if (approxBytes <= SIZE_LIMIT_BYTES) {
      return { ok: true, dataUrl: `data:image/png;base64,${pngBase64}`, mimeType: "image/png" }
    }

    // Too big — try JPEG re-encode.
    const jpeg = await this.#recompress(pngBase64, { toJpegQuality: JPEG_QUALITY })
    const jpegApproxBytes = Math.floor((jpeg.base64.length * 3) / 4)
    if (jpegApproxBytes <= SIZE_LIMIT_BYTES) {
      return {
        ok: true,
        dataUrl: `data:${jpeg.mimeType};base64,${jpeg.base64}`,
        mimeType: jpeg.mimeType,
      }
    }

    // Still too big — downscale.
    const downscaled = await this.#recompress(pngBase64, {
      toJpegQuality: JPEG_QUALITY,
      maxLongEdge: DOWNSCALE_LONG_EDGE,
    })
    return {
      ok: true,
      dataUrl: `data:${downscaled.mimeType};base64,${downscaled.base64}`,
      mimeType: downscaled.mimeType,
    }
  }

  // ─── Evaluate ─────────────────────────────────────────────────────────────

  async evaluate(expression: string): Promise<EvaluateResult> {
    if (!this.#agentAllowed) {
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", "agent-not-allowed")
      return { ok: false, error: { code: "eval-denied", message: "pane has not opted into agent JS execution" } }
    }
    if (this.#state !== "attached") {
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", "not-attached")
      return { ok: false, error: { code: "not-attached" } }
    }

    let resp: unknown
    try {
      resp = await this.#wc.debugger.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    } catch (err) {
      const message = errMsg(err)
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", message)
      return { ok: false, error: { code: "cdp-error", message } }
    }

    const exceptionDetails = readRecord(resp, "exceptionDetails")
    if (exceptionDetails) {
      const { message, stack } = parseExceptionDetails(exceptionDetails, "script error")
      this.#audit("evaluate", `eval (${expression.length} chars)`, "allowed", message)
      return {
        ok: false,
        error: { code: "script-error", message, stack: stack ? formatCallFrames(stack) : undefined },
      }
    }

    this.#audit("evaluate", `eval (${expression.length} chars)`, "allowed")
    return { ok: true, result: readUnknown(readRecord(resp, "result"), "value") }
  }

  // ─── Internal: state transitions ──────────────────────────────────────────

  async #handleDomReady(): Promise<void> {
    if (this.#state === "attaching" || this.#state === "reattaching") return
    if (this.#wc.isDestroyed()) return

    const isReattach = this.#state === "attached"
    this.#state = isReattach ? "reattaching" : "attaching"

    try {
      if (!this.#wc.debugger.isAttached()) {
        this.#wc.debugger.attach(CDP_PROTOCOL_VERSION)
      }
      // Flat mode — child sessions arrive as messages on the same `message`
      // channel with a `sessionId` tag, and we can address them directly on
      // sendCommand's third arg.
      await this.#wc.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      await this.#enableDomainsForSession(undefined)
      this.#state = "attached"
    } catch {
      // Attach can race with `destroyed` / DevTools opening. Roll back to
      // Detached so the next `dom-ready` / `devtools-closed` retries.
      this.#state = "detached"
    }
  }

  async #handleMainFrameNavigated(): Promise<void> {
    if (this.#state !== "attached") {
      // If we weren't attached, the next `dom-ready` will drive the attach.
      return
    }
    // Cross-origin nav swaps the RFH; re-enable domains and re-subscribe
    // auto-attach to catch the new target set. Child session ids are
    // invalidated — they'll re-appear via `Target.attachedToTarget`.
    this.#childSessionIds.clear()
    try {
      await this.#wc.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      })
      await this.#enableDomainsForSession(undefined)
    } catch {
      // The new RFH may not yet be ready to accept commands; the debugger
      // `detach` path or the next `dom-ready` will recover.
    }
  }

  #handleRenderProcessGone(): void {
    this.#childSessionIds.clear()
    this.#console.clear()
    // Debugger auto-detaches on render process gone. The next `dom-ready`
    // will drive reattach.
    this.#state = "detached"
  }

  async #enableDomainsForSession(sessionId: string | undefined): Promise<void> {
    for (const domain of ENABLED_DOMAINS) {
      try {
        await this.#wc.debugger.sendCommand(`${domain}.enable`, {}, sessionId)
      } catch {
        // `Overlay.enable` doesn't exist on worker targets; ignore individual
        // failures — the rest keep flowing.
      }
    }
  }

  // ─── Internal: debugger message routing ───────────────────────────────────

  #handleDebuggerMessage(method: string, params: unknown, sessionId: string | undefined): void {
    switch (method) {
      case "Target.attachedToTarget": {
        const childSessionId = readString(params, "sessionId")
        if (childSessionId) {
          this.#childSessionIds.add(childSessionId)
          void this.#enableDomainsForSession(childSessionId)
        }
        return
      }
      case "Target.detachedFromTarget": {
        const childSessionId = readString(params, "sessionId")
        if (childSessionId) this.#childSessionIds.delete(childSessionId)
        return
      }
      case "Runtime.consoleAPICalled": {
        if (!isRecord(params)) return
        this.#emit({
          level: mapConsoleType(readString(params, "type")),
          args: (readArray(params, "args") ?? []).map(describeRemoteObject),
          source: "console",
          sessionId: sessionId || undefined,
          stack: parseStackTrace(readRecord(params, "stackTrace")),
        })
        return
      }
      case "Runtime.exceptionThrown": {
        if (!isRecord(params)) return
        const { message, stack } = parseExceptionDetails(readRecord(params, "exceptionDetails"), "Uncaught exception")
        this.#emit({
          level: "error",
          args: [message],
          source: "exception",
          sessionId: sessionId || undefined,
          stack,
        })
        return
      }
      case "Log.entryAdded": {
        const entry = readRecord(params, "entry")
        if (!entry) return
        const args: string[] = []
        const text = readString(entry, "text")
        if (text !== undefined) args.push(text)
        const url = readString(entry, "url")
        if (url) args.push(`(${url})`)
        this.#emit({
          level: mapLogLevel(readString(entry, "level")),
          args,
          source: "log",
          sessionId: sessionId || undefined,
          stack: parseStackTrace(readRecord(entry, "stackTrace")),
        })
        return
      }
      default:
        // Ignore other CDP events — we only care about the console triumvirate.
        return
    }
  }

  #emit(input: {
    level: ConsoleLevel
    args: string[]
    source: "console" | "exception" | "log"
    sessionId?: string
    stack?: ConsoleStackFrame[]
  }): void {
    const entry = this.#console.append(input)
    for (const fn of this.#listeners) {
      try {
        fn(entry)
      } catch {
        // A single misbehaving consumer must not break the dispatch loop.
      }
    }
  }

  #audit(action: AgentAuditAction, summary: string, result: AgentAuditResult, reason?: string): void {
    try {
      this.#auditLog.append({
        paneId: `wc:${this.#wc.id}`,
        action,
        summary,
        result,
        reason,
      })
    } catch {
      // Audit log must never break a tool call.
    }
  }
}

// ─── CDP payload parsers ────────────────────────────────────────────────────
//
// Every CDP payload arrives untyped (see `../../shared/json-read`); these functions turn
// the handful of shapes this class cares about into the console buffer's
// vocabulary. Each call site used to declare its own hand-written copy of the
// CDP shape and cast the payload to it instead.

/** `Runtime.StackTrace` → the console buffer's frame shape. */
function parseStackTrace(stackTrace: unknown): ConsoleStackFrame[] | undefined {
  const callFrames = readArray(stackTrace, "callFrames")
  if (!callFrames?.length) return undefined
  return callFrames.map((frame) => ({
    url: readString(frame, "url"),
    function: readString(frame, "functionName"),
    line: readNumber(frame, "lineNumber"),
    column: readNumber(frame, "columnNumber"),
  }))
}

/**
 * `Runtime.ExceptionDetails` → a human-readable message plus its frames.
 * Shared by `Runtime.exceptionThrown` (console stream) and the
 * `Runtime.evaluate` failure path, which used to disagree on precedence.
 */
function parseExceptionDetails(
  details: unknown,
  fallbackMessage: string,
): { message: string; stack: ConsoleStackFrame[] | undefined } {
  const exception = readRecord(details, "exception")
  const thrownValue = readUnknown(exception, "value")
  const message =
    readString(exception, "description") ??
    readString(details, "text") ??
    (thrownValue === undefined || thrownValue === null ? fallbackMessage : stringifyRemoteValue(thrownValue))
  return { message, stack: parseStackTrace(readRecord(details, "stackTrace")) }
}

/** The `stack` string `evaluate()` reports back to its caller. */
function formatCallFrames(frames: ConsoleStackFrame[]): string {
  return frames
    .map((f) => `${f.function ?? "(anonymous)"} (${f.url ?? "?"}:${f.line ?? 0}:${f.column ?? 0})`)
    .join("\n")
}

function mapConsoleType(t: string | undefined): ConsoleLevel {
  switch (t) {
    case "warning":
      return "warn"
    case "error":
      return "error"
    case "info":
      return "info"
    case "debug":
    case "trace":
      return "debug"
    case "log":
    default:
      return "log"
  }
}

function mapLogLevel(l: string | undefined): ConsoleLevel {
  switch (l) {
    case "warning":
      return "warn"
    case "error":
      return "error"
    case "verbose":
    case "debug":
      return "debug"
    case "info":
      return "info"
    default:
      return "log"
  }
}

/** `Runtime.RemoteObject` → the one-line string the console buffer stores. */
function describeRemoteObject(arg: unknown): string {
  const value = readUnknown(arg, "value")
  if (value !== undefined) return stringifyRemoteValue(value)
  return readString(arg, "description") ?? readString(arg, "type") ?? ""
}

function stringifyRemoteValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return "[unserializable]"
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : stringifyRemoteValue(err)
}
