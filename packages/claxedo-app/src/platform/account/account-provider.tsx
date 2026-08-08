// target layer: account

import { type Component, type JSX, createContext, useContext } from "solid-js"
import { useAuthSession } from "@/platform/auth/auth-session"
import type { AccountPort } from "./account-port"
import { browserAccountPort, type RunHostedOperation } from "./browser-account-port"

/**
 * Who supplies the account port for this build.
 *
 * The browser supplies one built over its own session; Electron will supply one
 * backed by IPC, where main holds the credential and this process holds none.
 * Product code reads `useAccountPort()` and cannot tell which it got — that
 * indistinguishability is the point, because it is what lets the desktop change
 * where the credential lives without touching a product surface.
 */
const AccountPortContext = createContext<AccountPort>()

export const AccountPortProvider: Component<{ port?: AccountPort; children: JSX.Element }> = (props) => {
  // Built once from the ambient session when no port is injected. The session's
  // accessors are read inside `state()`, so this stays reactive.
  const auth = useAuthSession()
  const fallback = browserAccountPort(auth, notImplemented)
  return (
    <AccountPortContext.Provider value={props.port ?? fallback}>{props.children}</AccountPortContext.Provider>
  )
}

/**
 * Throws when no provider is above.
 *
 * Deliberately not a tolerant accessor returning `undefined`: an unconfigured
 * ports seam that degrades quietly is exactly how the WorkGraph doorbell shipped
 * inert with a green suite (`app-ports-wiring.guard.test.ts` documents that
 * failure). An account surface with no account port should be loud.
 */
export function useAccountPort(): AccountPort {
  const port = useContext(AccountPortContext)
  if (!port) throw new Error("useAccountPort() requires an <AccountPortProvider>")
  return port
}

/**
 * The operation transport before a build binds one.
 *
 * Named operations reach Hosted Server, and which transport carries them is a
 * per-build decision (browser session vs. Electron IPC) made in Units 9 and 11.
 * Until then, asking for one is a wiring bug and says so.
 */
const notImplemented: RunHostedOperation = async (operation) => {
  throw new Error(`hosted operation "${operation}" has no transport bound in this build`)
}
