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
 * `issuesSessions` is the server's own declaration, the same request
 * `CloudAuthGate` reads, so the gate and the adapter cannot disagree about
 * which deployment this is. The adapter starts when it settles rather than at
 * the render deadline: a slow answer read as "no sessions" there would settle
 * the adapter as unavailable for good while the gate, reading the late answer,
 * sends the visitor to a /login that cannot sign in. The gate holds while the
 * declaration is pending, and `initialize` marks the session loading before
 * the gate's query observer hears the answer. A server that declared nothing
 * is treated as one that issues no sessions.
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
  issuesSessions: Promise<boolean | undefined>
  adapter: Pick<BrowserAuthAdapter, "initialize">
  apiOrigin: string
  appOrigin: string
}): void {
  void input.issuesSessions.then((declared) =>
    input.adapter.initialize({
      apiOrigin: input.apiOrigin,
      appOrigin: input.appOrigin,
      issuesSessions: declared === true,
    }),
  )
}
