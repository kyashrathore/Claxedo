import type { BrowserAuthAdapter } from "@/platform/auth/browser-auth"
import { centralTransportForDeployment } from "@/platform/runtime/transport"

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
 * It reads `centralTransportForDeployment` once here and hands the answer down.
 * That is the same call `CloudAuthGate` makes to decide whether a signed
 * session is required at all, so the gate and the adapter cannot disagree
 * about which deployment this is; a loopback central is then anonymous by
 * contract, with no descriptor request and no provider SDK, decided by that
 * reading rather than by anything the adapter goes and finds out.
 *
 * Called at module scope, before `render()`, so a hosted build's first render
 * already reads `loading` and a signed user never sees the anonymous state
 * flash into a `/login` redirect.
 */
export function startBrowserAuth(input: {
  authEnabled: boolean
  adapter: Pick<BrowserAuthAdapter, "initialize">
  apiOrigin: string
  appOrigin: string
}): void {
  if (!input.authEnabled) return
  void input.adapter.initialize({
    apiOrigin: input.apiOrigin,
    appOrigin: input.appOrigin,
    centralTransport: centralTransportForDeployment({ serverUrl: input.apiOrigin, authEnabled: input.authEnabled }),
  })
}
