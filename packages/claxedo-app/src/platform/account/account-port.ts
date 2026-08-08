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
 * `docs/tech-docs/desktop-hosted-operation-matrix.md` is that set, and
 * `architecture/hosted-operation-inventory.test.ts` holds the two in step.
 *
 * The browser binds this port to its own session; Electron binds it to IPC.
 * Neither implementation hands a token, a cookie, a URL, or a method back to
 * the renderer.
 */

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
  | { status: "unsigned" }
  /** Sign-in is in flight — the system browser is open, or IPC is awaiting it. */
  | { status: "pending" }
  | { status: "signed"; identity: AccountIdentity }
  /**
   * Signed mode cannot work on this machine, with a reason to show.
   *
   * The important case is an unusable OS credential store: Electron's Linux
   * `basic_text` backend is not encryption, so signed mode must be refused
   * BEFORE OAuth rather than after storing a token in the clear. Unsigned local
   * work stays available throughout.
   */
  | { status: "unavailable"; reason: "no-secure-storage" | "callback-failed" | "revoked" }

/**
 * The operations the renderer may ask for, by name.
 *
 * Declared HERE and not in `hosted-operations.ts`, even though that module owns
 * each operation's decoder: this file is the port's contract and must stay
 * import-free, so it can be read on its own and so the import graph can see it
 * as the pure type contract it is. The registry imports this union and is
 * checked against it.
 *
 * A string union rather than a free-form key: an implementation that must
 * satisfy every member cannot quietly gain a passthrough, and a caller naming
 * something absent fails to compile rather than at runtime.
 */
export type HostedOperationName =
  | "account.get"
  | "account.mode"
  | "account.compatibility"
  | "account.cliExchange"
  // One per access kind, because the hosted list route answers rows only for
  // `cloud` or `user-hosted` and the access-less call is always empty. See the
  // rows in `claxedo-desktop/src/main/account/hosted-operations.ts`.
  | "workspace.list.cloud"
  | "workspace.list.userHosted"
  | "workspace.resolve"
  | "workspace.create"
  | "workspace.lifecycle"
  | "workspace.checkpoints.list"
  | "workspace.checkpoints.restore"
  | "workspace.connection.mint"
  | "workspace.connection.refresh"
  | "host.enrollCurrentMachine"
  | "host.enrollmentNonce"
  | "host.enrollmentHeartbeat"

export type AccountPort = {
  /** Current account state. Reactive in the renderer; a snapshot here. */
  state: () => AccountState
  /** Begins sign-in. Resolves when the attempt settles, not when it succeeds. */
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  /**
   * Runs one named hosted operation and returns its decoded result.
   *
   * No URL, no method, no headers — those are owned by whoever implements the
   * port. `input` is the operation's own parameters (a workspace id, a
   * lifecycle verb), never a request shape.
   */
  run: <T = unknown>(operation: HostedOperationName, input?: Record<string, unknown>) => Promise<T>
}

// There is deliberately no "unbound port" value here. `useAccountPort()` throws
// when no provider is above it, and a second, quieter way to be unbound would
// only give a wiring bug somewhere to hide.
