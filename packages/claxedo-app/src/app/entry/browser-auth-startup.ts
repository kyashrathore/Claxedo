import type { BrowserAuthAdapter } from "@/platform/auth/browser-auth"

/**
 * Start the identity provider a build selected, without letting it gate the
 * shell.
 *
 * The shell renders unconditionally. Auth is a signal underneath it —
 * `useAuthSession().status()` moves `loading` -> `signed`/`anonymous` — and
 * every surface that cares already resolves against that signal:
 * `CloudAuthGate` holds its children while `loading` and only sends an
 * `anonymous` visitor to `/login`, and `browserAccountPort` reports `pending`.
 *
 * Nothing here may gate `render()`: every way identity startup can fail — a
 * plain-http origin, an unreachable descriptor, a stalled response — must end
 * as an anonymous session with a reason, because `/login` (the one surface
 * that can fix a sign-in problem) lives inside the shell. `initialize`
 * therefore resolves in every case and reports its outcome through the
 * session signals, and this function only has to start it and get out of the
 * way.
 *
 * `issuesSessions` is the server's own declaration, resolved by the caller
 * before this runs and handed to `CloudAuthGate` as well, so the gate and the
 * adapter cannot disagree about which deployment this is. A server that
 * declared nothing is treated as one that issues no sessions.
 *
 * The adapter is started in every case rather than only where a session can
 * exist: `initialize` settles a deployment with no sign-in flow without a
 * request and without a session client (`browserAuthUnavailable`), so a
 * loopback daemon still loads no provider SDK, and refusing to start it here
 * as well would only skip the adapter's own test bypass — the seam the e2e
 * harness injects a principal through.
 *
 * Called before `render()`, so a signed deployment's first render already
 * reads `loading` and a signed user never sees the anonymous state flash into
 * a `/login` redirect.
 */
export function startBrowserAuth(input: {
  issuesSessions: boolean | undefined
  adapter: Pick<BrowserAuthAdapter, "initialize">
  apiOrigin: string
  appOrigin: string
}): void {
  void input.adapter.initialize({
    apiOrigin: input.apiOrigin,
    appOrigin: input.appOrigin,
    issuesSessions: input.issuesSessions === true,
  })
}
