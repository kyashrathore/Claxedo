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
 *      outerHTML ≤ 2 KB, bounding rect, key computed styles, page URL),
 *      forwards a breadcrumb to the host via
 *      `ipcRenderer.sendToHost("claxedo-browser-pick", payload)`, then
 *      mounts our own theme-aware comment popover (in our own shadow root)
 *      anchored to the picked element. The popover submits via
 *      `claxedo-browser-comment-submit` IPC. Returning `true` from
 *      `onElementSelect` suppresses react-grab's default copy flow.
 *
 *   3. Disables react-grab's toolbar AND its built-in selection-label /
 *      textarea via `theme.toolbar.enabled: false` and
 *      `theme.elementLabel.enabled: false` so our popover is the only
 *      comment surface. The selection box and hover highlight stay visible
 *      — they're the picker's "you're hovering / you picked this" state.
 *
 *   4. Listens for host→guest messages on the renderer's `ipc-message`
 *      channel (arrives here as `ipcRenderer.on("claxedo-picker:set-mode",
 *      …)`). `"comment"` → `api.activate()` (pure picker; our popover
 *      drives the rest), `"off"` → `api.deactivate()`. `"browse"` is
 *      currently a synonym for `"off"` (no browse-only mode in the MVP).
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
  theme?: {
    /** HSL hue (0-360) used as the base for all of react-grab's tinted UI. */
    hue?: number
    toolbar?: { enabled?: boolean }
    elementLabel?: { enabled?: boolean }
    selectionBox?: { enabled?: boolean }
    dragBox?: { enabled?: boolean }
    grabbedBoxes?: { enabled?: boolean }
  }
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

// ─── Claxedo comment popover (replaces react-grab's textarea) ────────────
// Mounted in our own shadow root, anchored to the picked element. Submits
// via the existing `claxedo-browser-comment-submit` IPC contract so the
// host-side parser in browser-pane.tsx (which splits content on "\n\n")
// doesn't change.

let popoverShadow: ShadowRoot | null = null
let popoverHost: HTMLDivElement | null = null
let activePopover: HTMLDivElement | null = null
let activeHighlight: HTMLDivElement | null = null
let popoverDismissHandler: ((ev: MouseEvent) => void) | null = null

// Theme tokens mirrored from the host renderer via the `claxedo-theme:tokens`
// IPC. We buffer the latest values in case they arrive before the popover host
// has been created, then apply them on creation. Inline styles on the host
// beat the @media (prefers-color-scheme) defaults in the shadow stylesheet,
// so the host's chosen theme wins regardless of OS preference.
type ClaxedoThemeTokens = Partial<Record<
  "bg" | "fg" | "muted" | "border" | "accent" | "accent-hover",
  string
>>
let latestThemeTokens: ClaxedoThemeTokens | null = null

function applyThemeTokens(tokens: ClaxedoThemeTokens): void {
  if (!popoverHost) return
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === "string" && value.length > 0) {
      popoverHost.style.setProperty(`--cx-${key}`, value)
    }
  }
}

const POPOVER_STYLE = `
  :host { all: initial; }
  .cx-popover {
    position: fixed; pointer-events: auto;
    min-width: 320px; max-width: 420px; padding: 10px;
    background: var(--cx-bg, #ffffff); color: var(--cx-fg, #18181b);
    border: 1px solid var(--cx-border, rgba(0,0,0,0.12));
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.4;
  }
  .cx-tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; color: var(--cx-muted, #71717a);
    margin-bottom: 6px; word-break: break-all;
    max-height: 32px; overflow: hidden;
  }
  .cx-textarea {
    display: block; box-sizing: border-box; width: 100%;
    min-height: 64px; max-height: 240px;
    padding: 6px 8px; resize: vertical;
    background: var(--cx-bg, #fff); color: var(--cx-fg, #18181b);
    border: 1px solid var(--cx-border, rgba(0,0,0,0.12));
    border-radius: 6px; outline: none;
    font: inherit;
  }
  .cx-textarea:focus {
    border-color: var(--cx-accent, #3b82f6);
    box-shadow: 0 0 0 2px var(--cx-accent-ring, rgba(59,130,246,0.2));
  }
  .cx-actions {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 8px; gap: 8px;
  }
  .cx-hint { font-size: 11px; color: var(--cx-muted, #71717a); }
  .cx-buttons { display: flex; gap: 6px; }
  .cx-btn {
    font: inherit; font-size: 12px; padding: 4px 10px;
    border-radius: 6px; cursor: pointer;
    background: var(--cx-bg, #fff); color: var(--cx-fg, #18181b);
    border: 1px solid var(--cx-border, rgba(0,0,0,0.12));
  }
  .cx-btn:hover { background: var(--cx-hover, rgba(0,0,0,0.04)); }
  .cx-btn-primary {
    background: var(--cx-accent, #3b82f6); color: #ffffff;
    border-color: var(--cx-accent, #3b82f6);
  }
  .cx-btn-primary:hover { background: var(--cx-accent-hover, #2563eb); }
  .cx-btn-primary:disabled {
    opacity: 0.5; cursor: not-allowed;
    background: var(--cx-accent, #3b82f6);
  }
  /* Highlight overlay drawn over the picked element. Translucent fill
     (matching the hover-overlay affordance) plus a subtle inset ring for
     edge definition. Lives in this shadow root so it survives the popover
     being torn down at submit-time, until the host signals deactivate.
     color-mix lets us derive both the fill alpha and ring alpha from the
     same --cx-accent so theme-token wiring updates everything together. */
  .cx-highlight {
    box-sizing: border-box;
    position: fixed; pointer-events: none;
    background: color-mix(in srgb, var(--cx-accent, #3b82f6) 22%, transparent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--cx-accent, #3b82f6) 50%, transparent) inset;
    border-radius: 3px;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --cx-bg: #18181b;
      --cx-fg: #e4e4e7;
      --cx-border: rgba(255,255,255,0.12);
      --cx-muted: #a1a1aa;
      --cx-hover: rgba(255,255,255,0.06);
    }
  }
`

function ensurePopoverRoot(): ShadowRoot | null {
  if (popoverShadow) return popoverShadow
  if (typeof document === "undefined" || !document.body) return null
  popoverHost = document.createElement("div")
  popoverHost.setAttribute("data-claxedo-popover-host", "true")
  Object.assign(popoverHost.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
    contain: "strict",
  } as Partial<CSSStyleDeclaration>)
  document.body.appendChild(popoverHost)
  popoverShadow = popoverHost.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = POPOVER_STYLE
  popoverShadow.appendChild(style)
  // Replay any tokens that arrived from the host before the host element
  // existed — common at first launch since the IPC fires on dom-ready but
  // ensurePopoverRoot runs lazily on first pick.
  if (latestThemeTokens) applyThemeTokens(latestThemeTokens)
  return popoverShadow
}

function closePopover(): void {
  if (activePopover) {
    activePopover.remove()
    activePopover = null
  }
  if (popoverDismissHandler) {
    document.removeEventListener("mousedown", popoverDismissHandler, true)
    popoverDismissHandler = null
  }
}

function clearHighlight(): void {
  if (activeHighlight) {
    activeHighlight.remove()
    activeHighlight = null
  }
}

function drawHighlight(rect: DOMRect): void {
  clearHighlight()
  const root = ensurePopoverRoot()
  if (!root) return
  const h = document.createElement("div")
  h.className = "cx-highlight"
  h.style.left = `${rect.left}px`
  h.style.top = `${rect.top}px`
  h.style.width = `${rect.width}px`
  h.style.height = `${rect.height}px`
  // Insert before the popover (if present) so the popover paints on top.
  if (activePopover) {
    root.insertBefore(h, activePopover)
  } else {
    root.appendChild(h)
  }
  activeHighlight = h
}

// Anchor below the element with viewport-edge flip; clamp to viewport.
function positionPopover(popover: HTMLElement, anchor: DOMRect): void {
  const margin = 8
  const ph = popover.offsetHeight || 180
  const pw = popover.offsetWidth || 360
  const vh = window.innerHeight
  const vw = window.innerWidth
  let top = anchor.bottom + margin
  if (top + ph > vh - margin) top = anchor.top - ph - margin
  let left = anchor.left
  if (left + pw > vw - margin) left = vw - pw - margin
  popover.style.top = `${Math.max(margin, top)}px`
  popover.style.left = `${Math.max(margin, left)}px`
}

function showPopover(el: Element): void {
  closePopover()
  clearHighlight()
  const root = ensurePopoverRoot()
  if (!root) {
    diag("popover-skip", { reason: "no-shadow-root" })
    return
  }
  // Draw the highlight first so the popover paints above it (DOM order in
  // the shadow root determines paint order without explicit z-index).
  drawHighlight(el.getBoundingClientRect())
  // Deactivate the picker while composing — react-grab's hover overlay
  // would otherwise track the cursor and visually conflict with the
  // popover. Dismiss / outside-click re-arms it (see dismiss() below).
  getReactGrabAPI()?.deactivate?.()

  const popover = document.createElement("div")
  popover.className = "cx-popover"

  const tag = document.createElement("div")
  tag.className = "cx-tag"
  tag.textContent = buildSelector(el)

  const textarea = document.createElement("textarea")
  textarea.className = "cx-textarea"
  textarea.placeholder = "Add a comment for the agent…"
  textarea.spellcheck = false
  textarea.autocapitalize = "off"

  const actions = document.createElement("div")
  actions.className = "cx-actions"

  const hint = document.createElement("div")
  hint.className = "cx-hint"
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
  hint.textContent = `${isMac ? "⌘" : "Ctrl"}+Enter to send · Esc to cancel`

  const buttons = document.createElement("div")
  buttons.className = "cx-buttons"
  const cancelBtn = document.createElement("button")
  cancelBtn.className = "cx-btn"
  cancelBtn.type = "button"
  cancelBtn.textContent = "Cancel"
  const sendBtn = document.createElement("button")
  sendBtn.className = "cx-btn cx-btn-primary"
  sendBtn.type = "button"
  sendBtn.textContent = "Send"
  sendBtn.disabled = true

  buttons.append(cancelBtn, sendBtn)
  actions.append(hint, buttons)
  popover.append(tag, textarea, actions)
  root.appendChild(popover)
  activePopover = popover

  const anchorRect = el.getBoundingClientRect()
  // Defer one frame so offsetWidth/Height reflect the rendered popover.
  requestAnimationFrame(() => {
    if (activePopover === popover) positionPopover(popover, anchorRect)
  })
  textarea.focus()

  // The picker deactivates after the host's `capturePage()` resolves and it
  // sends `claxedo-picker:set-mode: off` back to us — that path also clears
  // the highlight (see applyMode below). On submit we keep the highlight up
  // so it appears in the screenshot; on dismiss (no screenshot) we clear it
  // immediately and re-arm the picker so the user can pick another element.
  const dismiss = () => {
    closePopover()
    clearHighlight()
    getReactGrabAPI()?.activate?.()
  }
  const submit = () => {
    const content = textarea.value.trim()
    if (!content) return
    // Order matters: remove popover from DOM, force a paint cycle, THEN send
    // IPC. Without the double rAF, the host's capturePage() can read the
    // renderer's current (pre-mutation) surface — popover still showing,
    // highlight not yet composited. Two rAFs guarantee the next paint has
    // committed before we trigger the host-side capture.
    closePopover()
    // Highlight intentionally stays — it's the visual anchor in the screenshot.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sendCommentSubmit(el, content)
      })
    })
  }

  textarea.addEventListener("input", () => {
    sendBtn.disabled = textarea.value.trim().length === 0
  })
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault()
      dismiss()
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault()
      submit()
    }
  })
  cancelBtn.addEventListener("click", dismiss)
  sendBtn.addEventListener("click", submit)

  // Click outside (anywhere not inside the shadow host) closes the popover.
  // Capture-phase so it sees the click before the page does; use composedPath
  // to detect clicks landing inside our shadow root.
  popoverDismissHandler = (ev: MouseEvent) => {
    const path = ev.composedPath()
    if (popoverHost && path.includes(popoverHost)) return
    dismiss()
  }
  document.addEventListener("mousedown", popoverDismissHandler, true)
}

function sendCommentSubmit(el: Element, content: string): void {
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
  // Host parser in browser-pane.tsx splits on "\n\n" — comment first, snippet
  // after. Keep that contract so the host stays unchanged.
  const snippet = payload.outerHTML ?? `<${payload.tagName} />`
  try {
    ipcRenderer.sendToHost("claxedo-browser-comment-submit", {
      ...payload,
      content: `${content}\n\n${snippet}`,
    })
  } catch {
    // Host webview not wired — drop.
  }
}

const claxedoCommentPlugin: ReactGrabPlugin = {
  name: "claxedo-comment",
  // Disable react-grab chrome we don't need:
  //   - toolbar:       browser-pane has its own above the webview
  //   - elementLabel:  this is the textarea-morph for comment() mode
  //   - dragBox / grabbedBoxes: not used in our flow
  // selectionBox stays ENABLED — it's the hover-preview overlay (the tint
  // that tracks the cursor before click). The post-click variant is
  // suppressed because we call api.deactivate() in showPopover() the
  // instant the user picks.
  // hue=223 matches Claxedo's brand --text-interactive-base (#034cff ≈
  // HSL 223°). react-grab's hover preview tints to this hue, so when the
  // host's accent token flows in the cx-highlight overlay color will be
  // close to the hover preview color and the transition stays continuous.
  // (Hue is a static plugin config; we don't currently re-register on
  // theme change. Saturation/lightness still come from react-grab.)
  theme: {
    hue: 223,
    toolbar: { enabled: false },
    elementLabel: { enabled: false },
    dragBox: { enabled: false },
    grabbedBoxes: { enabled: false },
  },
  hooks: {
    onElementSelect: (element: Element) => {
      sendPick(element)
      showPopover(element)
      // Return true to suppress react-grab's default flow (copy in
      // activate() mode) so nothing lands on the system clipboard.
      return true
    },
  },
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
    // Use activate() (pure picker), not comment() — the latter enters react-grab's
    // prompt mode which would try to morph their selection-label into a textarea,
    // but we've disabled elementLabel and render our own popover from
    // onElementSelect.
    if (typeof api.activate !== "function") {
      diag("set-mode-fail", { reason: "no-activate", apiKeys })
      return
    }
    try {
      api.activate()
      diag("set-mode-ok", { mode })
    } catch (err) {
      diag("set-mode-fail", { reason: "activate-threw", error: String(err) })
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
  // Picker is off — drop any lingering highlight from the most recent submit
  // (whose screenshot the host has by now captured) or stale state.
  clearHighlight()
  closePopover()
}

ipcRenderer.on("claxedo-picker:set-mode", (_event, mode: PickerMode) => {
  diag("set-mode-received", { mode })
  applyMode(mode)
})

// Host pushes theme tokens (background, text, accent, etc.) on dom-ready and
// whenever the user toggles light/dark. We buffer the latest set and apply
// them to the popover host as inline CSS variables. The shadow stylesheet's
// :host defaults + @media (prefers-color-scheme) blocks are the fallback
// when no tokens arrive (e.g., test harness or detached webview).
ipcRenderer.on("claxedo-theme:tokens", (_event, tokens: ClaxedoThemeTokens) => {
  if (!tokens || typeof tokens !== "object") return
  latestThemeTokens = tokens
  if (popoverHost) applyThemeTokens(tokens)
})
