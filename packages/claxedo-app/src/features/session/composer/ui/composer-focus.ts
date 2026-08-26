// Shared "focus the visible composer editor" helper.
//
// The composer editor renders as `[data-component="prompt-input"]` with
// `role="textbox"` and `contenteditable="true"` (see `prompt-input/frame.tsx`).
// Several keyboard-flow entry points need to hand focus to it after a
// navigation/mount:
//   - the palette/chord "New session" command (focus must not be left on BODY),
//   - the "skip to composer" bypass link that lets a keyboard user jump past the
//     project/session tree in the sidebar.
//
// A surface can mount more than one prompt-input node during a route transition
// (an outgoing one kept `visibility:hidden` for animation, plus the live one),
// so we skip hidden/aria-hidden nodes and only focus a live, editable one.

/** Focus the first visible, editable composer editor. Returns whether one was focused. */
export function focusComposerSurface(doc: Document = document): boolean {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>('[data-component="prompt-input"]'))
  for (const node of nodes) {
    if (node.getAttribute("contenteditable") !== "true") continue
    if (node.getAttribute("aria-hidden") === "true") continue
    const style = doc.defaultView?.getComputedStyle(node)
    if (style && style.visibility === "hidden") continue
    node.focus()
    if (doc.activeElement === node) return true
  }
  return false
}

// Focus has to happen after the destination surface mounts, so the handoff is
// deferred a frame. Exposed as a mutable object so tests can run it
// synchronously without leaning on real timers/rAF.
export const composerFocus = {
  schedule(run: () => void): void {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => run())
      return
    }
    queueMicrotask(run)
  },
}

// A destination composer (e.g. a fresh draft opened by "New session") mounts
// asynchronously after the route change and data load, so a single deferred
// attempt can fire before it exists. Retry across a bounded number of frames
// until the composer is present, then give up and run the fallback. We stop
// early (without stealing focus) if the user has already moved focus to some
// other real target while we were waiting.
//
// `from` names the control that is handing focus over. Callers triggered by a
// command or a bypass link start from BODY, so "focus is on a real element"
// was a safe proxy for "the user moved focus, leave it alone". A caller
// triggered by clicking a control does not: the click leaves focus on that
// control, which the proxy would read as the user having moved focus, and the
// handoff would never happen. Declaring the origin keeps the bail-out intact
// for every other target while letting the originating control hand off.
export function focusComposerWhenReady(options?: {
  attempts?: number
  fallback?: () => void
  doc?: Document
  from?: Element | null
}): void {
  const doc = options?.doc ?? document
  const maxAttempts = options?.attempts ?? 150 // ~2.5s at 60fps — draft mount can be slow
  let tries = 0
  const tick = () => {
    const active = doc.activeElement
    const userMovedFocus =
      !!active &&
      active !== doc.body &&
      active !== options?.from &&
      active.getAttribute("data-component") !== "prompt-input"
    if (userMovedFocus) return
    if (focusComposerSurface(doc)) return
    tries += 1
    if (tries >= maxAttempts) {
      options?.fallback?.()
      return
    }
    composerFocus.schedule(tick)
  }
  composerFocus.schedule(tick)
}
