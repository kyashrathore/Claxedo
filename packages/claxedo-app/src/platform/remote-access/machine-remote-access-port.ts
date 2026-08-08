/**
 * How the app asks for THIS MACHINE to be published for remote access, without
 * owning a way to do it.
 *
 * "Enable remote access" is one user action with two entirely different
 * mechanisms underneath, decided by which product is running:
 *
 *   - **Self-hosted Node** serves `/api/claxedo/remote-access/*` itself
 *     (`deployments/self-hosted-node/app.ts`), so its implementation is an
 *     authenticated HTTP call to its own origin.
 *   - **The desktop** does not. Its sidecar is `@claxedo/local-server`, which
 *     deliberately serves none of those paths — machine publication moved to
 *     the Host Connector in Electron main, which holds the machine key and the
 *     account credential. Its implementation is named IPC.
 *
 * The surface is the same in both, so it must name the OPERATION and not the
 * request. A hardcoded `fetch("/api/claxedo/remote-access/enable")` in shared
 * app code is what broke: the route left the desktop's sidecar and the button
 * kept calling it, which is a 404 no test noticed because no test was looking
 * at the transport.
 *
 * Same shape and the same reasons as `platform/account/account-port.ts` and
 * `platform/runtime/workspace-startup-port.ts`: the contract is declared here
 * and stays import-free, so it reads on its own and the import graph sees it as
 * the pure type contract it is. Implementations live beside it; each
 * composition root binds one through `configureMachineRemoteAccess`.
 *
 * ## Optional members are capabilities, not conveniences
 *
 * A product that genuinely cannot perform an operation leaves it ABSENT rather
 * than binding a stub that resolves to nothing. A stub makes "this product
 * cannot enumerate every machine on the account" indistinguishable from "the
 * account has no machines", and the surface would render the second while
 * meaning the first. Callers check for the member.
 */

/**
 * Everything the Remote Access surface needs to decide what to show.
 *
 * Deliberately the input shape of `remoteAccessAvailability()` plus `enrolled`,
 * because that derivation is the single reader of all six fields and splitting
 * them would only give two places to disagree.
 *
 * How each implementation answers is documented on the implementation. The two
 * `*Configured` flags are the product's own answer to "can this build publish a
 * machine at all", not a promise about anyone's server config.
 */
export type MachineRemoteAccessStatus = {
  deviceLoginConfigured: boolean
  relayConfigured: boolean
  hostedSignedIn: boolean
  /** A machine identity exists AND the control plane currently accepts it. */
  enrolled: boolean
  /** Enrolled and actively reachable — the heartbeat is beating. */
  enabled: boolean
  secondDeviceOpen: boolean
}

/** One enrolled machine, as the account sees it. */
export type MachineRemoteAccessDevice = {
  hostId: string
  displayName: string
  lastSeenAt: number
  workspaceIds: readonly string[]
}

export type MachineRemoteAccessPort = {
  status: () => Promise<MachineRemoteAccessStatus>
  /**
   * Publish this machine. The user's explicit action, never a launch effect.
   *
   * Resolves when the machine is published and REJECTS when it is not, which is
   * the whole result. It deliberately returns nothing: the HTTP route answers
   * with a host id, a workspace list and a connection count, all three of which
   * belong to the retired per-workspace registration, and none of which any
   * caller reads. A shape kept alive for one implementation would have forced
   * the other to invent values for it.
   *
   * `startAtLogin` is carried because the HTTP product has no other channel for
   * it; the desktop sets its login item through the platform descriptor and
   * ignores this field. `displayName` is the label shown in the device list.
   */
  enable: (input: { displayName: string; startAtLogin: boolean }) => Promise<void>
  /** Stop publishing a machine for good. */
  revoke: (hostId: string) => Promise<{ revoked: boolean }>
  /**
   * Every machine on the account.
   *
   * Absent on the desktop: enumerating the account's machines is an
   * authenticated read of a route that is not in the desktop's closed operation
   * set, and the connector knows only about itself.
   */
  devices?: () => Promise<readonly MachineRemoteAccessDevice[]>
  /**
   * Stop publishing this machine, keeping its identity for a later `enable`.
   *
   * Absent on the HTTP product: there is no pause route there, and the surface
   * offers revoke instead.
   */
  pause?: () => Promise<MachineRemoteAccessStatus>
  /**
   * Record that the workspace was opened from a SECOND signed-in client.
   *
   * Absent on the desktop: the second device is by definition the other one — a
   * phone or another browser — so the machine that published itself is never
   * the one making this call.
   */
  markSecondDeviceOpen?: (input: {
    workspaceId: string
    sourceClientId: string
    currentClientId: string
  }) => Promise<{ recorded: boolean }>
  /**
   * Be told when the status changes without asking.
   *
   * Absent on the HTTP product, which has nothing to push with. The desktop
   * does: a rejected heartbeat, an expiry or a revocation changes the answer
   * with no user action, and a surface that only ever polls shows a machine as
   * published for as long as nobody clicks.
   */
  subscribe?: (listener: (status: MachineRemoteAccessStatus) => void) => () => void
}
