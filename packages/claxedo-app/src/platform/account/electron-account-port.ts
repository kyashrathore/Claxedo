// target layer: account

import { createSignal, type Accessor } from "solid-js"
import type { AccountPort, AccountState, HostedOperationName } from "./account-port"

/**
 * The desktop's `AccountPort`: every answer comes from Electron main.
 *
 * This process holds no credential. It names an operation, main decides the
 * method and path, attaches the token it holds, and sends back a decoded
 * result. The renderer cannot construct a request, which is what makes the
 * arrangement worth having — a renderer compromise gets the thirteen operations
 * the product uses and not the rest of the API.
 *
 * `browserAccountPort` is the same shape over the browser's own session. Product
 * code cannot tell which it received, and that is the point: moving where the
 * credential lives changed no product surface.
 */

/** The bridge the preload exposes. Absent in a browser build. */
export type AccountBridge = {
  state: () => Promise<AccountState>
  signIn: () => Promise<AccountState>
  signOut: () => Promise<AccountState>
  run: (operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>
}

/**
 * Wrap the bridge, keeping the last state in a signal.
 *
 * Main owns the state and answers asynchronously; `AccountPort.state` is
 * synchronous because Solid components read it during render. A signal
 * reconciles the two: the port reports what it last heard, and every call that
 * could change the answer updates it.
 */
export function electronAccountPort(bridge: AccountBridge): AccountPort & { refresh: () => Promise<void> } {
  // `pending`, not `unsigned`, until main answers. Reporting unsigned first
  // flashes a login prompt at a signed user on every launch.
  const [state, setState] = createSignal<AccountState>({ status: "pending" })

  const adopt = async (next: Promise<AccountState>) => {
    try {
      setState(await next)
    } catch {
      // Recorded, not rethrown. `unavailable` IS the report — the port's whole
      // contract is that `signIn` resolves when the attempt SETTLES, and
      // rejecting as well would give every call site a second way to learn the
      // same thing and make the eager refresh below an unhandled rejection.
      //
      // A failing bridge is a desktop wiring problem, not a signed-out user, so
      // it must not read as one.
      setState({ status: "unavailable", reason: "callback-failed" })
    }
  }

  const refresh = () => adopt(bridge.state())
  void refresh()

  return {
    state: state as Accessor<AccountState>,
    refresh,
    signIn: () => adopt(bridge.signIn()),
    signOut: () => adopt(bridge.signOut()),
    run: (operation, input) => bridge.run(operation, input) as never,
  }
}

/**
 * The bridge, if this build has one.
 *
 * Read through a narrow accessor rather than at module scope so a browser build
 * never touches `window.api`, and so the check is one expression a test can
 * exercise.
 */
export function accountBridge(scope: unknown = globalThis): AccountBridge | undefined {
  const api = (scope as { api?: { account?: AccountBridge } }).api?.account
  if (!api) return undefined
  // All four or none. A partial bridge is a preload that changed under a
  // renderer that did not, and calling the missing half would fail at the worst
  // moment rather than at startup.
  for (const member of ["state", "signIn", "signOut", "run"] as const) {
    if (typeof api[member] !== "function") return undefined
  }
  return api
}
