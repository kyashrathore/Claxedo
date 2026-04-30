/**
 * Browser-tab guest preload.
 *
 * Attached to the agent-browser `<webview>` via its `preload` attribute. Runs
 * in the guest's renderer process (isolated from the host renderer and the
 * main process) and:
 *
 *   1. Loads the `react-grab` runtime — a SolidJS-based, in-page element
 *      picker/overlay library. React-grab's module auto-initializes on
 *      import: it assigns a `ReactGrabAPI` to `window.__REACT_GRAB__` and
 *      drains any queued plugins. The only gating flag is
 *      `window.__REACT_GRAB_DISABLED__`; there is no `NODE_ENV ===
 *      "development"` check anywhere in the published runtime, so we
 *      simply let the auto-init run. We never touch
 *      `__REACT_GRAB_DISABLED__`, so it stays on.
 *
 *      The react-grab bundle is *not* bundled into this preload directly —
 *      electron-vite's preload build externalizes every npm dep by
 *      default, and the dist is designed as a single browser-global IIFE.
 *      A `closeBundle` plugin in `electron.vite.config.ts` prepends
 *      `react-grab/dist/index.global.js` to the compiled preload so the
 *      final `.mjs` file is fully self-contained.
 *
 *   2. Registers a custom `"claxedo-comment"` plugin whose
 *      `hooks.onElementSelect` harvests a structured payload (selector,
 *      outerHTML ≤ 2 KB, bounding rect, key computed styles, page URL) and
 *      forwards it to the host renderer via
 *      `ipcRenderer.sendToHost("claxedo-browser-pick", payload)`. Returning
 *      `true` from `onElementSelect` suppresses react-grab's default copy
 *      behavior so nothing lands on the system clipboard.
 *
 *   3. Disables react-grab's default floating toolbar by passing
 *      `theme.toolbar.enabled: false` via the plugin config. The Claxedo
 *      browser-pane already surfaces its own Inspect / picker controls in
 *      the React toolbar above the webview — two toolbars would compete
 *      visually and capture pointer events. The overlay + selection label
 *      are left visible (that's the whole point of the replacement).
 *
 *   4. Listens for host→guest messages on the renderer's `ipc-message`
 *      channel (arrives here as `ipcRenderer.on("claxedo-picker:set-mode",
 *      …)`). `"comment"` → `api.comment()`, `"off"` → `api.deactivate()`.
 *      `"browse"` is currently a synonym for `"off"` (no browse-only mode
 *      in the MVP).
 */

import { ipcRenderer } from "electron"

// ─── Diagnostics ─────────────────────────────────────────────────────────
// Every step of the bootstrap sends a breadcrumb both to the host renderer
// (ipc-message channel "claxedo-preload:diag") and to the guest's own
// console (visible via Open DevTools). Silent failures have been the cause
// of every "overlay doesn't show" miss so far.
function diag(step: string, detail?: Record<string, unknown>): void {
  const payload = { step, detail: detail ?? null, t: Date.now() }
  // eslint-disable-next-line no-console
  console.log("[claxedo-preload]", step, detail ?? "")
  try {
    ipcRenderer.sendToHost("claxedo-preload:diag", payload)
  } catch {
    // sendToHost may not be connected yet — console.log is the backup.
  }
}

diag("preload-loaded", {
  href: typeof window !== "undefined" ? window.location?.href : null,
  hasReactGrabModule:
    typeof (globalThis as { __REACT_GRAB_MODULE__?: unknown }).__REACT_GRAB_MODULE__ === "object",
  hasReactGrab: typeof (window as unknown as { __REACT_GRAB__?: unknown }).__REACT_GRAB__ === "object",
})

type PickPayload = {
  selector: string
  frameUrl: string
  tagName: string
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

/** Subset of react-grab's runtime we touch at register / imperative time. */
type ReactGrabPlugin = {
  name: string
  theme?: { toolbar?: { enabled?: boolean } }
  hooks?: {
    onElementSelect?: (element: Element) => boolean | void | Promise<boolean>
    onCopySuccess?: (elements: Element[], content: string) => void
  }
  actions?: Array<{
    id: string
    label: string
    onAction: (ctx: { element: Element }) => void | Promise<void>
  }>
}
type ReactGrabAPI = {
  activate: () => void
  deactivate: () => void
  toggle: () => void
  comment: () => void
  registerPlugin: (plugin: ReactGrabPlugin) => void
}

const OUTER_HTML_LIMIT = 2048

/**
 * Best-effort CSS selector generator. We prefer a short, unique path rooted
 * at `id`; we fall back to nth-of-type indexing for ambiguous children. A
 * lightweight hand-rolled path is fine because the picker only needs the
 * selector good enough for a human to recognize the element in the comment
 * payload — the agent consumes the accompanying `outerHTML` and bounding
 * box too, so selector precision is not load-bearing.
 */
function buildSelector(el: Element): string {
  if (el.id) return `#${cssEscape(el.id)}`
  const parts: string[] = []
  let node: Element | null = el
  while (node && parts.length < 6) {
    const tag = node.tagName.toLowerCase()
    let part = tag
    if (node.id) {
      parts.unshift(`${tag}#${cssEscape(node.id)}`)
      break
    }
    const cls = (node.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(cssEscape)
    if (cls.length) part += "." + cls.join(".")
    const parent: ParentNode | null = node.parentNode
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
      if (sibs.length > 1) {
        const idx = sibs.indexOf(node) + 1
        part += `:nth-of-type(${idx})`
      }
    }
    parts.unshift(part)
    node = node.parentElement
  }
  return parts.join(" > ")
}

function cssEscape(s: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (x: string) => string } }).CSS?.escape === "function") {
    return (globalThis as { CSS: { escape: (x: string) => string } }).CSS.escape(s)
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}

function pickComputedStyles(el: Element): PickPayload["computedStyles"] {
  try {
    const cs = (el.ownerDocument?.defaultView ?? window).getComputedStyle(el as HTMLElement)
    return {
      color: cs.color || undefined,
      backgroundColor: cs.backgroundColor || undefined,
      fontFamily: cs.fontFamily || undefined,
      fontSize: cs.fontSize || undefined,
      display: cs.display || undefined,
    }
  } catch {
    return undefined
  }
}

function buildPayload(el: Element): PickPayload {
  const rect = el.getBoundingClientRect()
  const outer = (el as HTMLElement).outerHTML ?? ""
  const truncated = outer.length > OUTER_HTML_LIMIT ? `${outer.slice(0, OUTER_HTML_LIMIT)}…` : outer
  return {
    selector: buildSelector(el),
    frameUrl: window.location.href,
    tagName: el.tagName.toLowerCase(),
    outerHTML: truncated,
    boundingBox: {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    computedStyles: pickComputedStyles(el),
  }
}

function sendPick(el: Element): void {
  let payload: PickPayload
  try {
    payload = buildPayload(el)
  } catch {
    payload = {
      selector: "",
      frameUrl: window.location.href,
      tagName: el.tagName?.toLowerCase?.() ?? "unknown",
    }
  }
  try {
    ipcRenderer.sendToHost("claxedo-browser-pick", payload)
  } catch {
    // Guest <webview> may not yet be wired to a host contents — drop.
  }
}

const claxedoCommentPlugin: ReactGrabPlugin = {
  name: "claxedo-comment",
  // Turn off react-grab's own toolbar — the browser pane ships its own
  // above the webview and two competing toolbars steal clicks. The
  // picker/selection-box/element-label stay visible; only the floating
  // bottom toolbar row is hidden.
  theme: {
    toolbar: { enabled: false },
  },
  hooks: {
    onElementSelect: (element: Element) => {
      // Send a host-side breadcrumb so the pane can track the last-selected
      // node for agent tools (screenshot, console-log scraping), but return
      // void so react-grab continues into its own inline comment popover
      // (that's the "Add a comment…" bubble attached to the element).
      sendPick(element)
    },
    // Fires after react-grab has compiled the final prompt (user's comment
    // + element snippet) and written it to the clipboard. We forward the
    // compiled content plus our own structured element payload to the host
    // renderer, which routes it into the bound session via `sendPageComment`
    // on the pane bus. Clipboard still gets the content — losing nothing —
    // but the comment also lands in the chat tied to this browser tab.
    onCopySuccess: (elements: Element[], content: string) => {
      const el = elements[0]
      if (!el) return
      let payload: PickPayload
      try {
        payload = buildPayload(el)
      } catch {
        payload = {
          selector: "",
          frameUrl: window.location.href,
          tagName: el.tagName?.toLowerCase?.() ?? "unknown",
        }
      }
      try {
        ipcRenderer.sendToHost("claxedo-browser-comment-submit", {
          ...payload,
          content,
        })
      } catch {
        // Host webview may not be wired yet; clipboard still has it.
      }
    },
  },
  // react-grab also accepts context-menu actions. We register one so when
  // users right-click with the picker armed, "Comment" routes through our
  // plugin rather than the built-in clipboard path. The same `sendPick`
  // helper keeps the payload shape identical to the onElementSelect path.
  actions: [
    {
      id: "claxedo-comment-action",
      label: "Comment",
      onAction: (ctx) => {
        sendPick(ctx.element)
      },
    },
  ],
}

function getReactGrabAPI(): ReactGrabAPI | undefined {
  return (window as unknown as { __REACT_GRAB__?: ReactGrabAPI }).__REACT_GRAB__
}

let pluginInstalled = false
function installPlugin(): void {
  if (pluginInstalled) return
  const api = getReactGrabAPI()
  if (!api) {
    diag("plugin-register-skip", { reason: "no-api" })
    return
  }
  try {
    if (typeof api.registerPlugin !== "function") {
      diag("plugin-register-fail", {
        reason: "no-registerPlugin-method",
        apiKeys: Object.keys(api as unknown as Record<string, unknown>),
      })
      return
    }
    api.registerPlugin(claxedoCommentPlugin)
    pluginInstalled = true
    diag("plugin-registered")
    installShadowOverrides()
  } catch (err) {
    diag("plugin-register-fail", { reason: "threw", error: String(err) })
  }
}

/**
 * Inject theme + chrome overrides into react-grab's shadow root.
 *
 * React-grab renders everything inside a single open shadow root attached
 * to `<div data-react-grab="true">` (confirmed via its own source at
 * `document.querySelector('[data-react-grab]')`). External stylesheets
 * don't pierce shadow DOM, so we need to append our own `<style>` inside.
 *
 *   - The post-copy context menu (`[data-react-grab-context-menu]`) is
 *     hidden: Claxedo routes the element through our own composer and the
 *     "Copy / Copy HTML / Copy styles / Open" menu adds redundant chrome.
 *   - `prefers-color-scheme: dark` support: react-grab ships a fixed
 *     light palette (white backgrounds, black text). We override the
 *     highest-level surfaces (popover, context menu, overlay labels) so
 *     the picker matches the OS theme — which Electron threads through to
 *     the guest renderer by default. This is a coarse pass; the element
 *     outline / selection label stay at react-grab's defaults.
 *
 * The shadow host is created lazily on first activate(), so we retry a
 * few times in case it's not yet in the DOM when the plugin registers.
 */
function installShadowOverrides(): void {
  const attempt = (retriesLeft: number) => {
    const host = document.querySelector("[data-react-grab]") as (Element & { shadowRoot: ShadowRoot | null }) | null
    const shadow = host?.shadowRoot
    if (!shadow) {
      if (retriesLeft > 0) {
        setTimeout(() => attempt(retriesLeft - 1), 200)
      } else {
        diag("shadow-overrides-skip", { reason: "no-shadow-host" })
      }
      return
    }
    if (shadow.querySelector("style[data-claxedo-overrides]")) return
    const style = document.createElement("style")
    style.setAttribute("data-claxedo-overrides", "true")
    style.textContent = `
      /* Hide the post-copy context menu. Claxedo's inline comment popover is
         the only affordance we surface; the Copy / HTML / Styles / Open menu
         duplicates what the agent consumes via IPC anyway. */
      [data-react-grab-context-menu] { display: none !important; }

      /* Hide the "Copied" completion toast. We route content to the bound
         session via IPC (onCopySuccess hook), so the copy flow is happening
         — but a "Copied" confirmation is wrong because the user's mental
         model is "this went to chat," not "this went to clipboard". */
      [data-react-grab-completion] { display: none !important; }

      /* Dark-mode overrides. React-grab uses white surfaces + black text
         throughout; swap the load-bearing surfaces so the picker is readable
         when the host/OS is in dark mode. Light mode is unchanged. */
      @media (prefers-color-scheme: dark) {
        [data-react-grab-completion],
        [data-react-grab-context-menu],
        [data-react-grab-comments-dropdown],
        [data-react-grab-clear-comments-prompt],
        [data-react-grab-error],
        [data-react-grab-toolbar] {
          background-color: rgb(24 24 27) !important;
          color: rgb(228 228 231) !important;
          border-color: rgb(63 63 70) !important;
        }
        [data-react-grab-menu-item] {
          color: rgb(228 228 231) !important;
        }
        [data-react-grab-menu-item]:hover,
        [data-react-grab-arrow-nav-item][data-react-grab-arrow-nav-index]:hover {
          background-color: rgb(39 39 42) !important;
        }
        [data-react-grab-input] {
          background-color: rgb(24 24 27) !important;
          color: rgb(228 228 231) !important;
          border-color: rgb(63 63 70) !important;
        }
        [data-react-grab-selection-label],
        [data-react-grab-unread-indicator] {
          background-color: rgb(39 39 42) !important;
          color: rgb(228 228 231) !important;
        }
      }
    `
    shadow.appendChild(style)
    diag("shadow-overrides-installed")
  }
  attempt(10)
}

// react-grab ships two builds. `dist/index.js` (ESM) has a bottom-of-file
// auto-init that calls `init()` and sets `window.__REACT_GRAB__`. The
// `dist/index.global.js` IIFE we prepend (because electron-vite externalizes
// every npm dep) only REGISTERS a module object at
// `globalThis.__REACT_GRAB_MODULE__` — no auto-init. We reproduce that
// missing step here.
type ReactGrabModule = {
  init: () => ReactGrabAPI
  setGlobalApi?: (api: ReactGrabAPI) => void
  getGlobalApi?: () => ReactGrabAPI | null
}
function bootstrapReactGrab(): void {
  if (typeof window === "undefined") {
    diag("bootstrap-skip", { reason: "no-window" })
    return
  }
  const w = window as unknown as { __REACT_GRAB__?: ReactGrabAPI; __REACT_GRAB_DISABLED__?: boolean }
  if (w.__REACT_GRAB_DISABLED__) {
    diag("bootstrap-skip", { reason: "disabled-flag" })
    return
  }
  if (w.__REACT_GRAB__) {
    diag("bootstrap-skip", { reason: "already-initialized" })
    return
  }
  // Force-run the deferred IIFE only if the DOM is already parsed. Running
  // it before DOMContentLoaded throws `appendChild(null)` inside react-grab
  // because document.body/head aren't mounted yet. If the document is
  // still loading, skip — the DOMContentLoaded handler installed by the
  // vite plugin wrapper will run it later, and the retry on set-mode will
  // pick up the module when it's ready.
  const runIife = (globalThis as unknown as { __CLAXEDO_RUN_REACT_GRAB_IIFE__?: () => void })
    .__CLAXEDO_RUN_REACT_GRAB_IIFE__
  const domReady = typeof document !== "undefined" && document.readyState !== "loading"
  if (typeof runIife === "function" && domReady) {
    try {
      runIife()
    } catch {
      // IIFE wrapper swallows internally and stashes error on globalThis.
    }
  }
  const mod = (globalThis as unknown as { __REACT_GRAB_MODULE__?: ReactGrabModule }).__REACT_GRAB_MODULE__
  if (!mod) {
    // If the IIFE threw at load time, the vite-plugin wrapper stashes the
    // error on globalThis. Surface it so we can see why the module never
    // registered (bippy mis-init, ReferenceError on `this`, etc.).
    const iifeError = (globalThis as unknown as {
      __CLAXEDO_REACT_GRAB_IIFE_ERROR__?: { message: string; stack: string | null }
    }).__CLAXEDO_REACT_GRAB_IIFE_ERROR__
    diag("bootstrap-fail", {
      reason: "no-module-on-globalThis",
      iifeError: iifeError ?? null,
      hasRunner: typeof runIife === "function",
      globalKeys: Object.keys(globalThis as Record<string, unknown>).filter((k) =>
        k.toLowerCase().includes("react") || k.toLowerCase().includes("grab"),
      ),
    })
    return
  }
  const modKeys = Object.keys(mod as Record<string, unknown>)
  diag("bootstrap-module-found", { keys: modKeys })
  if (typeof mod.init !== "function") {
    diag("bootstrap-fail", { reason: "no-init-fn", keys: modKeys })
    return
  }
  try {
    const api = mod.init()
    if (!api) {
      diag("bootstrap-fail", { reason: "init-returned-nullish" })
      return
    }
    w.__REACT_GRAB__ = api
    const apiKeys = Object.keys(api as unknown as Record<string, unknown>)
    try {
      mod.setGlobalApi?.(api)
    } catch (err) {
      diag("bootstrap-warn", { reason: "setGlobalApi-threw", error: String(err) })
    }
    window.dispatchEvent(new CustomEvent("react-grab:init", { detail: api }))
    diag("bootstrap-ok", { apiKeys })
  } catch (err) {
    diag("bootstrap-fail", { reason: "init-threw", error: String(err), stack: err instanceof Error ? err.stack : null })
  }
}

// Electron sandboxed preloads run at document-start, BEFORE `document.body`
// exists. React-grab's `init()` mounts overlay DOM immediately, so an early
// call can throw (or silently bail) and leave `window.__REACT_GRAB__`
// unset — which is exactly what our diagnostics caught: every `set-mode`
// call lands with `reason: "no-api"`.
//
// Strategy: try once now (cheap if it works), but if it didn't stick, retry
// on DOMContentLoaded and again lazily on the first `set-mode` call. Each
// retry is idempotent (the early-return guards in `bootstrapReactGrab`
// handle already-initialized/disabled paths).
function tryBootstrap(reason: string): boolean {
  if (getReactGrabAPI()) return true
  diag("bootstrap-retry", { reason })
  bootstrapReactGrab()
  return !!getReactGrabAPI()
}

tryBootstrap("preload-start")

if (getReactGrabAPI()) {
  installPlugin()
} else {
  // Re-attempt at DOMContentLoaded: by then `document.body` exists and
  // react-grab can mount its overlay root. If it still fails, the lazy
  // retry in `applyMode` below is our last line of defense.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          if (tryBootstrap("dom-content-loaded")) {
            installPlugin()
          }
        },
        { once: true },
      )
    } else {
      // Already past DOMContentLoaded — try on next tick so other preload
      // setup can finish first, then install the plugin.
      queueMicrotask(() => {
        if (tryBootstrap("already-parsed")) {
          installPlugin()
        }
      })
    }
  }
  window.addEventListener(
    "react-grab:init",
    () => {
      installPlugin()
    },
    { once: true },
  )
}

/**
 * Host→guest mode channel. The host renderer dispatches
 * `webview.send("claxedo-picker:set-mode", mode)`; Electron surfaces that
 * on this preload's `ipcRenderer` as an ordinary `on(channel, …)` event.
 */
type PickerMode = "comment" | "browse" | "off"

function applyMode(mode: PickerMode): void {
  let api = getReactGrabAPI()
  if (!api) {
    // Last-chance bootstrap: preload may have loaded before `document.body`
    // existed, so `init()` silently failed. By the time the user clicks
    // Inspect, the DOM is ready and react-grab can mount cleanly.
    if (tryBootstrap("set-mode-lazy")) {
      installPlugin()
      api = getReactGrabAPI()
    }
  }
  if (!api) {
    diag("set-mode-fail", { reason: "no-api", mode })
    return
  }
  // Re-attempt shadow overrides here — the shadow host is created lazily
  // on first activate(), so the install at plugin-register time may not
  // have found it yet. Idempotent: noops if our style is already present.
  installShadowOverrides()
  const apiKeys = Object.keys(api as unknown as Record<string, unknown>)
  if (mode === "comment") {
    if (typeof api.comment !== "function") {
      // Some react-grab versions expose only `activate()`. Try that as a
      // fallback so we at least enter picker mode; the plugin's onElementSelect
      // hook still fires regardless of which entry point turned it on.
      if (typeof api.activate === "function") {
        try {
          api.activate()
          diag("set-mode-ok", { mode, via: "activate-fallback" })
          return
        } catch (err) {
          diag("set-mode-fail", { reason: "activate-threw", error: String(err), apiKeys })
          return
        }
      }
      diag("set-mode-fail", { reason: "no-comment-or-activate", apiKeys })
      return
    }
    try {
      api.comment()
      diag("set-mode-ok", { mode })
    } catch (err) {
      diag("set-mode-fail", { reason: "comment-threw", error: String(err) })
    }
    return
  }
  if (typeof api.deactivate !== "function") {
    diag("set-mode-fail", { reason: "no-deactivate", apiKeys })
    return
  }
  try {
    api.deactivate()
    diag("set-mode-ok", { mode })
  } catch (err) {
    diag("set-mode-fail", { reason: "deactivate-threw", error: String(err) })
  }
}

ipcRenderer.on("claxedo-picker:set-mode", (_event, mode: PickerMode) => {
  diag("set-mode-received", { mode })
  applyMode(mode)
})
