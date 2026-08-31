// target layer: account

import { type Component, type JSX, createContext, useContext } from "solid-js"
import type { AccountPort } from "./account-port"

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

export const AccountPortProvider: Component<{ port: AccountPort; children: JSX.Element }> = (props) => (
  <AccountPortContext.Provider value={props.port}>{props.children}</AccountPortContext.Provider>
)

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
