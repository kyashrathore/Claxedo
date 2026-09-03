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
export function shellRevealedOnce() {
  return (window as { __claxedoShellRevealed?: boolean }).__claxedoShellRevealed === true
}

export function markShellRevealed() {
  ;(window as { __claxedoShellRevealed?: boolean }).__claxedoShellRevealed = true
}
