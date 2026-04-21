/**
 * BrowserHandle — main-process wrapper around a single agent-browser
 * `<webview>`'s `webContents`. Owns the CDP attach state machine, streams
 * console entries into a ring buffer, and exposes `screenshot`, `evaluate`,
 * and `getConsoleLogs` for the IPC layer to call through.
 *
 * State machine (per the plan's "CDP state machine"):
 *
 *   Detached → Attaching → Attached → Reattaching → Attached
 *
 *   - `dom-ready` (first time or after crash) →
 *       debugger.attach("1.3")
 *       + Target.setAutoAttach({ flatten: true, waitForDebuggerOnStart: false })
 *       + enable Runtime / Page / Log / Overlay / DOM on the top session
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

import type { Event, WebContents } from "electron"

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

export type BrowserHandleState = "detached" | "attaching" | "attached" | "reattaching"

const CDP_PROTOCOL_VERSION = "1.3"
const ENABLED_DOMAINS = ["Runtime", "Page", "Log", "Overlay", "DOM"] as const

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
 * Minimal subset of Electron's `WebContents` that the handle actually touches.
 * Extracted so `handle.test.ts` can stub without standing up Electron.
 */
export type BrowserWc = Pick<
  WebContents,
  "id" | "isDestroyed" | "loadURL" | "getURL" | "on" | "off" | "removeAllListeners"
> & {
  debugger: BrowserDebugger
}

export type BrowserDebugger = {
  attach(protocolVersion?: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, commandParams?: unknown, sessionId?: string): Promise<unknown>
  on(event: "message" | "detach", listener: (...args: unknown[]) => void): unknown
  off(event: "message" | "detach", listener: (...args: unknown[]) => void): unknown
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
  #onDidNavigate: (event: Event, url: string, statusCode: number, statusText: string, isMainFrame: boolean) => void
  #onRenderProcessGone: () => void
  #onDevtoolsClosed: () => void
  #onWcDestroyed: () => void
  #onDebuggerDetach: (event: unknown, reason: string) => void
  #onDebuggerMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void

  constructor(wc: BrowserWc, opts: BrowserHandleOptions = {}) {
    this.#wc = wc
    this.#auditLog = opts.auditLog ?? defaultAgentAuditLog
    this.#recompress = opts.recompress ?? passthroughRecompress

    this.#onDomReady = () => {
      void this.#handleDomReady()
    }
    this.#onDidNavigate = (_event, _url, _statusCode, _statusText, isMainFrame) => {
      // Non-main-frame navigations don't swap the RFH, so skip.
      if (isMainFrame === false) return
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
    this.#onDebuggerDetach = (_event, _reason) => {
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
    this.#wc.on("dom-ready", this.#onDomReady as never)
    this.#wc.on("did-navigate", this.#onDidNavigate as never)
    this.#wc.on("render-process-gone", this.#onRenderProcessGone as never)
    this.#wc.on("devtools-closed", this.#onDevtoolsClosed as never)
    this.#wc.on("destroyed", this.#onWcDestroyed as never)
    this.#wc.debugger.on("detach", this.#onDebuggerDetach as never)
    this.#wc.debugger.on("message", this.#onDebuggerMessage as never)
  }

  get webContents(): WebContents {
    return this.#wc as unknown as WebContents
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
    this.#agentAllowed = Boolean(allowed)
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
      this.#wc.off("dom-ready", this.#onDomReady as never)
      this.#wc.off("did-navigate", this.#onDidNavigate as never)
      this.#wc.off("render-process-gone", this.#onRenderProcessGone as never)
      this.#wc.off("devtools-closed", this.#onDevtoolsClosed as never)
      this.#wc.off("destroyed", this.#onWcDestroyed as never)
      this.#wc.debugger.off("detach", this.#onDebuggerDetach as never)
      this.#wc.debugger.off("message", this.#onDebuggerMessage as never)
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
      const response = (await this.#wc.debugger.sendCommand("Page.captureScreenshot", params)) as { data?: string }
      if (!response || typeof response.data !== "string") {
        return { ok: false, error: { code: "cdp-error", message: "Page.captureScreenshot returned no data" } }
      }
      pngBase64 = response.data
    } catch (err) {
      return { ok: false, error: { code: "cdp-error", message: String(err instanceof Error ? err.message : err) } }
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

    let resp: {
      result?: { value?: unknown; type?: string; description?: string }
      exceptionDetails?: {
        text?: string
        exception?: { description?: string; value?: unknown }
        stackTrace?: { callFrames?: Array<{ url?: string; functionName?: string; lineNumber?: number; columnNumber?: number }> }
      }
    }
    try {
      resp = (await this.#wc.debugger.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as typeof resp
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", message)
      return { ok: false, error: { code: "cdp-error", message } }
    }

    if (resp && resp.exceptionDetails) {
      const details = resp.exceptionDetails
      const message =
        details.exception?.description ?? (typeof details.text === "string" ? details.text : "script error")
      const stack = details.stackTrace?.callFrames
        ?.map((f) => `${f.functionName ?? "(anonymous)"} (${f.url ?? "?"}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0})`)
        .join("\n")
      this.#audit("evaluate", `eval (${expression.length} chars)`, "allowed", message)
      return { ok: false, error: { code: "script-error", message, stack } }
    }

    this.#audit("evaluate", `eval (${expression.length} chars)`, "allowed")
    return { ok: true, result: resp?.result?.value }
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
        const p = params as { sessionId?: string } | undefined
        if (p?.sessionId) {
          this.#childSessionIds.add(p.sessionId)
          void this.#enableDomainsForSession(p.sessionId)
        }
        return
      }
      case "Target.detachedFromTarget": {
        const p = params as { sessionId?: string } | undefined
        if (p?.sessionId) this.#childSessionIds.delete(p.sessionId)
        return
      }
      case "Runtime.consoleAPICalled": {
        const p = params as RuntimeConsoleAPICalledParams | undefined
        if (!p) return
        const level = mapConsoleType(p.type)
        const args = (p.args ?? []).map(describeRemoteObject)
        this.#emit({
          level,
          args,
          source: "console",
          sessionId: sessionId || undefined,
          stack: p.stackTrace ? mapStackTrace(p.stackTrace) : undefined,
        })
        return
      }
      case "Runtime.exceptionThrown": {
        const p = params as RuntimeExceptionThrownParams | undefined
        if (!p) return
        const details = p.exceptionDetails
        const text =
          details?.exception?.description ?? details?.text ?? details?.exception?.value ?? "Uncaught exception"
        this.#emit({
          level: "error",
          args: [String(text)],
          source: "exception",
          sessionId: sessionId || undefined,
          stack: details?.stackTrace ? mapStackTrace(details.stackTrace) : undefined,
        })
        return
      }
      case "Log.entryAdded": {
        const p = params as LogEntryAddedParams | undefined
        if (!p?.entry) return
        const level = mapLogLevel(p.entry.level)
        const args: string[] = []
        if (typeof p.entry.text === "string") args.push(p.entry.text)
        if (p.entry.url) args.push(`(${p.entry.url})`)
        this.#emit({
          level,
          args,
          source: "log",
          sessionId: sessionId || undefined,
          stack: p.entry.stackTrace ? mapStackTrace(p.entry.stackTrace) : undefined,
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

// ─── CDP shape helpers ──────────────────────────────────────────────────────

type RuntimeConsoleAPICalledParams = {
  type?: string
  args?: Array<{ type?: string; value?: unknown; description?: string; preview?: unknown }>
  stackTrace?: { callFrames?: Array<{ url?: string; functionName?: string; lineNumber?: number; columnNumber?: number }> }
}

type RuntimeExceptionThrownParams = {
  exceptionDetails?: {
    text?: string
    exception?: { description?: string; value?: unknown }
    stackTrace?: { callFrames?: Array<{ url?: string; functionName?: string; lineNumber?: number; columnNumber?: number }> }
  }
}

type LogEntryAddedParams = {
  entry?: {
    level?: string
    text?: string
    url?: string
    source?: string
    stackTrace?: { callFrames?: Array<{ url?: string; functionName?: string; lineNumber?: number; columnNumber?: number }> }
  }
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

function describeRemoteObject(arg: { type?: string; value?: unknown; description?: string }): string {
  if (arg.value !== undefined) {
    return typeof arg.value === "string" ? arg.value : safeStringify(arg.value)
  }
  if (typeof arg.description === "string") return arg.description
  return arg.type ?? ""
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function mapStackTrace(st: {
  callFrames?: Array<{ url?: string; functionName?: string; lineNumber?: number; columnNumber?: number }>
}): ConsoleStackFrame[] | undefined {
  if (!st?.callFrames?.length) return undefined
  return st.callFrames.map((f) => ({
    url: f.url,
    function: f.functionName,
    line: f.lineNumber,
    column: f.columnNumber,
  }))
}
