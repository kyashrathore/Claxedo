/**
 * How the renderer reaches an account, without ever holding one.
 *
 * After the split a signed desktop reaches Hosted Server through Electron main,
 * which owns the credential. The renderer therefore cannot make an
 * authenticated call itself — it asks for a NAMED operation and receives a
 * decoded result.
 *
 * There is exactly one wrong way to build this and it is the obvious way:
 * expose `invoke("hostedFetch", { url, method, body })` and let the renderer
 * keep calling what it calls today. That is a confused deputy — main holds the
 * credential, so a renderer compromise could spend it on any route, including
 * ones no product surface uses. The whole value of this port is that the set of
 * things it can be asked to do is CLOSED and reviewable.
 *
 * `HostedOperationName` (`@claxedo/account-contract`) is that set; Electron
 * main's route table is typed against it, and every module that reaches
 * authenticated transport must be declared in the hosted-operation inventory.
 *
 * The browser binds this port to its own session; Electron binds it to IPC.
 * Neither implementation hands a token, a cookie, a URL, or a method back to
 * the renderer.
 */
import type { HostedOperationName } from "@claxedo/account-contract"
import type { BrowserAuthSignInOptions } from "../auth/browser-auth"

/** Sanitized identity. Deliberately the same shape a `Principal` may hold. */
export type AccountIdentity = {
  userId: string
  displayName?: string
  email?: string
  orgId?: string
  orgName?: string
  /**
   * How the account was proved, already rendered for display ("Google").
   *
   * A finished string rather than the provider id, because the id
   * (`oauth_google`) is the identity provider's vocabulary and no product
   * surface should have to translate it — least of all one that will be reading
   * a different provider's answer over IPC.
   */
  method?: string
}

export type AccountState =
  | { status: "unsigned"; remoteRevocation?: "confirmed" | "uncertain"; detail?: string }
  /** Sign-in is in flight — the system browser is open, or IPC is awaiting it. */
  | { status: "pending" }
  /**
   * Signed. `identity` is empty until the profile lookup answers; when that
   * lookup fails the account is still signed — the credential is what signs
   * you in, the profile only names you — and `identityLookup: "failed"` says
   * so, so the rail can stop spinning instead of waiting forever.
   */
  | { status: "signed"; identity: AccountIdentity; identityLookup?: "failed" }
  /**
   * Signed mode cannot work on this machine, with a reason to show.
   *
   * The important case is an unusable OS credential store: Electron's Linux
   * `basic_text` backend is not encryption, so signed mode must be refused
   * BEFORE OAuth rather than after storing a token in the clear. Unsigned local
   * work stays available throughout.
   */
  | { status: "unavailable"; reason: "no-secure-storage" | "callback-failed" | "revoked" }

export type AccountPort = {
  /** Current account state. Reactive in the renderer; a snapshot here. */
  state: () => AccountState
  /**
   * Begins sign-in. Resolves when the attempt settles, not when it succeeds.
   * `redirectUrl` is where the browser flow lands after the provider returns;
   * the desktop port ignores it — main owns that flow end to end.
   */
  signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  signOut: () => Promise<void>
  /**
   * Runs one named hosted operation and returns its decoded result.
   *
   * No URL, no method, no headers — those are owned by whoever implements the
   * port. `input` is the operation's own parameters (a workspace id, a
   * lifecycle verb), never a request shape.
   *
   * The result is `unknown` on purpose. This used to be `<T = unknown>`, which
   * let a CALLER name the result shape while no implementation could honour
   * that promise: every port satisfied it with an assertion (`as never` in the
   * browser port, `as AccountPort["run"]` in the Electron one). Callers narrow
   * with `decodeHostedResult`, which reads the operation's own decoder out of
   * `HOSTED_OPERATIONS` and names the operation when the shape is wrong.
   */
  run: (operation: HostedOperationName, input?: Record<string, unknown>) => Promise<unknown>
}

// There is deliberately no "unbound port" value here. `useAccountPort()` throws
// when no provider is above it, and a second, quieter way to be unbound would
// only give a wiring bug somewhere to hide.
