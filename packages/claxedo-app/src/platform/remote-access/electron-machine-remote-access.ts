import type {
  MachineRemoteAccessPort,
  MachineRemoteAccessStatus,
} from "./machine-remote-access-port"

/**
 * The port over Electron IPC, where the Host Connector lives.
 *
 * The desktop's sidecar serves no `/api/claxedo/remote-access/*` route — those
 * paths belong to the Host Connector now, and the connector is in Electron
 * main because that is where the machine key and the account credential are.
 * So this renderer performs no request at all: it names one of four operations
 * and receives a snapshot back.
 *
 * ## Why the bridge has exactly four members and no fifth
 *
 * Main holds the account bearer. A bridge member shaped
 * `run(url, method, body)` would let a compromised renderer spend that bearer
 * on any route the control plane exposes, which is the confused deputy
 * `platform/account/account-port.ts` describes at length. The same rule applies
 * here for the same reason, and more sharply: main also holds a machine signing
 * key that never expires. The set of things this bridge can be asked to do is
 * closed, reviewable, and takes no request shape from this process.
 *
 * Nothing here ever receives a token. `HostConnectorSnapshot` is a projection
 * of the connector's state — a status word, an id, an expiry, a reason — and
 * `claxedo-desktop/src/main/host-connector/status-channel.ts` is the single
 * place that builds it.
 */

/**
 * What every host-connector operation answers with.
 *
 * Declared here rather than imported from the desktop package, the same way
 * `electron-account-port.ts` declares `AccountBridge`: `@claxedo/app` does not
 * depend on `claxedo-desktop`, and the desktop's own contract test is what
 * holds the two in step.
 */
export type HostConnectorSnapshot = {
  /** `not-started` | `unavailable` | `idle` | `enrolled` | `stopped`. */
  status: string
  /** Whether this build can publish a machine at all — an account client is configured. */
  available: boolean
  /** Whether an account is signed in. Enrollment is signed by the machine and authorized by the owner. */
  signedIn: boolean
  expiresAt?: number
  reason?: string
  detail?: string
}

/** The bridge the preload exposes. Absent in every non-Electron build. */
export type HostConnectorBridge = {
  status: () => Promise<HostConnectorSnapshot>
  start: () => Promise<HostConnectorSnapshot>
  pause: () => Promise<HostConnectorSnapshot>
  revoke: () => Promise<HostConnectorSnapshot>
  onStatus: (listener: (snapshot: HostConnectorSnapshot) => void) => () => void
}

const BRIDGE_MEMBERS = ["status", "start", "pause", "revoke", "onStatus"] as const

/**
 * The bridge, if this build has one.
 *
 * Read through a narrow accessor rather than at module scope so a browser build
 * never touches `window.api`, and so the check is one expression a test can
 * exercise. All five members or none: a partial bridge is a preload that
 * changed under a renderer that did not, and the half that is missing would
 * fail at the worst moment rather than at startup.
 */
export function hostConnectorBridge(scope: unknown = globalThis): HostConnectorBridge | undefined {
  const api = (scope as { api?: { hostConnector?: HostConnectorBridge } }).api?.hostConnector
  if (!api) return undefined
  for (const member of BRIDGE_MEMBERS) {
    if (typeof api[member] !== "function") return undefined
  }
  return api
}

/**
 * Project the connector's snapshot onto the status the surface reads.
 *
 * Two decisions worth stating, because both look like shortcuts and neither is:
 *
 *   - **`deviceLoginConfigured` and `relayConfigured` both mean `available`.**
 *     On the HTTP product those two flags report a server's own configuration.
 *     The desktop reaches the hosted control plane, not a server it configured,
 *     so the honest desktop answer to "can this build publish a machine" is one
 *     fact: whether the build has an account client at all. Reporting it under
 *     both names keeps `remoteAccessAvailability()` a single derivation instead
 *     of growing a per-product branch.
 *   - **`enrolled` equals `enabled`.** The connector is enrolled exactly while
 *     its heartbeat is beating; an enrollment nobody beats for expires inside a
 *     minute. There is no persisted "enrolled but idle" state, and inventing
 *     one would matter: `remote-access-controller.ts` auto-enables when it sees
 *     `enrolled && !enabled`, so a desktop that reported a remembered
 *     enrollment at launch would publish the user's laptop on startup — the one
 *     thing the connector's construction site refuses to do.
 */
export function machineRemoteAccessStatus(snapshot: HostConnectorSnapshot): MachineRemoteAccessStatus {
  const enrolled = snapshot.status === "enrolled"
  return {
    deviceLoginConfigured: snapshot.available,
    relayConfigured: snapshot.available,
    hostedSignedIn: snapshot.signedIn,
    enrolled,
    enabled: enrolled,
    // The desktop is the machine that PUBLISHED itself, so it is never the
    // second device. Whether some other client opened the workspace is a fact
    // only the control plane holds, and reading it is not one of the four
    // operations. Reported false rather than guessed.
    secondDeviceOpen: false,
  }
}

export function electronMachineRemoteAccess(bridge: HostConnectorBridge): MachineRemoteAccessPort {
  return {
    async status() {
      return machineRemoteAccessStatus(await bridge.status())
    },

    // `displayName` and `startAtLogin` are deliberately unread. Main labels the
    // machine itself — the label is not the renderer's to choose when main is
    // the process that signs the enrollment — and the desktop's login item is
    // set through the platform descriptor's `setStartAtLogin`, which the
    // controller already calls beside this.
    async enable() {
      const snapshot = await bridge.start()
      if (snapshot.status !== "enrolled") {
        throw new Error(
          snapshot.detail ?? snapshot.reason ?? `Remote access did not start (${snapshot.status})`,
        )
      }
    },

    async pause() {
      return machineRemoteAccessStatus(await bridge.pause())
    },

    /**
     * Revoke this machine.
     *
     * `hostId` is not forwarded, and main's revoke takes no argument: it can
     * only ever stop the connector and destroy the key on this disk. That is
     * not a shortcut — a desktop that could revoke an arbitrary host id would
     * be spending main's account credential on a machine the user is not
     * sitting at, and the id would have come from a list this product cannot
     * even fetch (`devices` is absent here). One machine, and it is this one.
     */
    async revoke(_hostId: string) {
      const snapshot = await bridge.revoke()
      return { revoked: snapshot.status !== "enrolled" }
    },

    subscribe(listener) {
      return bridge.onStatus((snapshot) => listener(machineRemoteAccessStatus(snapshot)))
    },
  }
}
