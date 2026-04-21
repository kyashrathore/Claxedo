/**
 * `will-attach-webview` hardening for agent-browser panes.
 *
 * Runs for every webview attach across the app. If the guest is targeting the
 * agent-browser partition, we:
 *   - strip dangerous embedder-set attributes (`preload`, `preloadURL`, ...)
 *   - reject any `webpreferences` string enabling unsafe flags
 *   - force `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
 *   - force the partition to `persist:agent-browser`
 *   - validate the attached `src` scheme (http/https only; `about:blank` allowed)
 *
 * Any guest whose partition does *not* match the agent-browser partition is
 * rejected outright (`event.preventDefault()`). No other part of claxedo uses
 * `<webview>` today, so this is the correct default — we only light up the
 * attach path for this feature.
 *
 * References:
 *   - https://www.electronjs.org/docs/latest/api/webview-tag
 *   - https://www.electronjs.org/docs/latest/tutorial/security
 */

export const AGENT_BROWSER_PARTITION = "persist:agent-browser"

const DANGEROUS_WEBPREF_TOKENS = [
  "nodeIntegration",
  "contextIsolation",
  "webSecurity",
  "allowRunningInsecureContent",
  "experimentalFeatures",
] as const

// Attributes on the <webview> element that Electron surfaces via params; anything
// that can influence guest execution is stripped regardless of the caller.
const DANGEROUS_PARAM_KEYS = [
  "preload",
  "preloadURL",
  "nodeintegration",
  "nodeIntegration",
  "nodeintegrationinsubframes",
  "nodeIntegrationInSubFrames",
  "enableremotemodule",
  "enableRemoteModule",
  "disablewebsecurity",
  "allowpopups",
] as const

const ALLOWED_SRC_SCHEMES = new Set(["http:", "https:"])
// `about:blank` is allowed because Electron fires `will-attach-webview` with it
// when the <webview> is created without an initial `src` and we set one later
// via loadURL.
const ALLOWED_SRC_EXACT = new Set(["about:blank", ""])

export type WillAttachEvent = {
  preventDefault(): void
}

export type WillAttachWebPreferences = {
  partition?: string
  preload?: string
  preloadURL?: string
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  nodeIntegrationInWorker?: boolean
  contextIsolation?: boolean
  sandbox?: boolean
  webSecurity?: boolean
  allowRunningInsecureContent?: boolean
  experimentalFeatures?: boolean
  enableBlinkFeatures?: string
  webviewTag?: boolean
  [key: string]: unknown
}

export type WillAttachParams = {
  src?: string
  partition?: string
  webpreferences?: string
  [key: string]: unknown
}

export type WillAttachHandlerOptions = {
  /** Partition guests are pinned to. Defaults to `persist:agent-browser`. */
  partition?: string
  /** Optional hook for structured logging (reject reasons, stripped attrs). */
  onReject?: (reason: string, params: WillAttachParams) => void
}

/**
 * Build the handler function. Pure — pulled out so the test can drive it
 * without touching Electron internals.
 */
export function createWillAttachWebviewHandler(opts: WillAttachHandlerOptions = {}) {
  const expectedPartition = opts.partition ?? AGENT_BROWSER_PARTITION
  const onReject = opts.onReject ?? (() => {})

  return function willAttachWebview(
    event: WillAttachEvent,
    webPreferences: WillAttachWebPreferences,
    params: WillAttachParams,
  ): void {
    // Only accept the agent-browser partition. Every other partition — including
    // the embedder's default partition or any attempt at "persist:real-user" —
    // is rejected outright.
    const requestedPartition = (params.partition ?? webPreferences.partition ?? "").trim()
    if (requestedPartition !== expectedPartition) {
      onReject(
        `partition "${requestedPartition}" is not allowed (expected "${expectedPartition}")`,
        params,
      )
      event.preventDefault()
      return
    }

    // Reject any src that is not http(s) / about:blank. File, custom-scheme,
    // javascript:, and data: are all denied.
    const rawSrc = typeof params.src === "string" ? params.src.trim() : ""
    if (!isAllowedSrc(rawSrc)) {
      onReject(`src "${rawSrc}" is not an allowed scheme`, params)
      event.preventDefault()
      return
    }

    // Reject webpreferences strings that try to toggle dangerous flags. The
    // embedder's HTML can set this attribute; we never trust it.
    if (typeof params.webpreferences === "string" && params.webpreferences.length > 0) {
      const lower = params.webpreferences.toLowerCase()
      for (const token of DANGEROUS_WEBPREF_TOKENS) {
        if (lower.includes(token.toLowerCase())) {
          onReject(`webpreferences contains dangerous token "${token}"`, params)
          event.preventDefault()
          return
        }
      }
    }

    // Strip dangerous attributes from params too, so the host renderer cannot
    // smuggle them through. Electron does not re-read params after this event,
    // but deleting makes the intent explicit and keeps the object clean.
    for (const key of DANGEROUS_PARAM_KEYS) {
      if (key in params) delete (params as Record<string, unknown>)[key]
    }
    if ("webpreferences" in params) {
      delete (params as Record<string, unknown>).webpreferences
    }

    // Strip any preload the embedder tried to inject, regardless of case.
    if ("preload" in webPreferences) delete webPreferences.preload
    if ("preloadURL" in webPreferences) delete webPreferences.preloadURL

    // Hard-pin security-critical webPreferences. Electron respects what we
    // leave on this object at return time.
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.nodeIntegrationInWorker = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.experimentalFeatures = false
    if ("enableBlinkFeatures" in webPreferences) delete webPreferences.enableBlinkFeatures
    webPreferences.partition = expectedPartition
  }
}

function isAllowedSrc(raw: string): boolean {
  if (ALLOWED_SRC_EXACT.has(raw)) return true
  try {
    const url = new URL(raw)
    return ALLOWED_SRC_SCHEMES.has(url.protocol)
  } catch {
    return false
  }
}

export const __testing = {
  DANGEROUS_WEBPREF_TOKENS,
  DANGEROUS_PARAM_KEYS,
  ALLOWED_SRC_SCHEMES,
}
