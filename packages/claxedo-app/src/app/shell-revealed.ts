/**
 * Whether this WINDOW has shown the shell at least once.
 *
 * Signing in deliberately remounts the provider subtree (data isolation
 * between accounts) and switches the active server, so the full-page boot
 * splashes would replay as a flash on every account transition — and any
 * later suspension under a shell-wide boundary would replace a shell the
 * user already had with a boot logo. The window carries the fact across
 * those remounts; per-window, never persisted.
 *
 * Both shell-wide Suspense boundaries consult this one flag: the root
 * boundary in `app/entry/app.tsx` and the app-shell boundary in
 * `app/app-shell-bootstrap.tsx`.
 */
import { onMount } from "solid-js"

declare global {
  interface Window {
    /** Set by `markShellRevealed`; see this module's header for why it lives on the window. */
    __claxedoShellRevealed?: boolean
    /** Set once the first real pane content mounts; see `MainContentReady`. */
    __claxedoMainContentReady?: boolean
  }
}

export function shellRevealedOnce() {
  return window.__claxedoShellRevealed === true
}

export function markShellRevealed() {
  window.__claxedoShellRevealed = true
}

/**
 * The boot splash is a Suspense fallback — it unmounts the moment the shell's
 * lazy chunk resolves, while the draft composer's own lazy hops still leave a
 * blank main region behind it. This flag lets the boot overlay outlive the
 * boundary until a surface's real content has mounted, then retire for the
 * life of the window (post-sign-in remounts never replay it).
 */
export function mainContentReady() {
  return window.__claxedoMainContentReady === true
}

export function markMainContentReady() {
  window.__claxedoMainContentReady = true
}

/** Mount inside a surface's real content — past its last lazy/Suspense gate. */
export function MainContentReady() {
  onMount(markMainContentReady)
  return null
}
