import type {
  MachineRemoteAccessPort,
  MachineRemoteAccessStatus,
} from "@/platform/remote-access/machine-remote-access-port"
import { isRecord, readUnknown } from "../../shared/json-read"

/**
 * The port over Electron IPC, where the Host Connector lives.
 *
 * The desktop's sidecar serves no `/api/claxedo/remote-access/*` route — those
 * paths belong to the Host Connector now, and the connector is in Electron
 * main because that is where the machine key and the account credential are.
 * So this renderer performs no request at all: it names one of a closed set of
 * operations and receives a snapshot back.
 *
 * ## Why the bridge is a closed set and not a request
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
 * Declared beside the desktop adapter rather than imported from Electron main,
 * so the renderer never depends on main-process implementation modules. The
 * desktop's contract tests hold both sides in step.
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
  /** Workspaces this machine currently publishes. */
  sharedWorkspaceIds?: readonly string[]
  /** The name this machine is published under. Main derives or remembers it. */
  displayName?: string
}

/** The bridge the preload exposes. Absent in every non-Electron build. */
export type HostConnectorBridge = {
  status: () => Promise<HostConnectorSnapshot>
  start: () => Promise<HostConnectorSnapshot>
  pause: () => Promise<HostConnectorSnapshot>
  revoke: () => Promise<HostConnectorSnapshot>
  /** Publish one workspace: data-only input, the proof is main's and the child's. */
  share: (input: { workspaceId: string; displayName?: string }) => Promise<HostConnectorSnapshot>
  /** Withdraw one workspace. */
  unshare: (input: { workspaceId: string }) => Promise<HostConnectorSnapshot>
  /** Name this machine. No host id crosses — main reads it from the connector. */
  rename: (input: { displayName: string }) => Promise<HostConnectorSnapshot>
  onStatus: (listener: (snapshot: HostConnectorSnapshot) => void) => () => void
}

const BRIDGE_MEMBERS = ["status", "start", "pause", "revoke", "share", "unshare", "rename", "onStatus"] as const

/**
 * The bridge, if this build has one.
 *
 * Read through a narrow accessor rather than at module scope so a browser build
 * never touches `window.api`, and so the check is one expression a test can
 * exercise. Every member or none: a partial bridge is a preload that
 * changed under a renderer that did not, and the half that is missing would
 * fail at the worst moment rather than at startup.
 */
function isHostConnectorBridge(value: unknown): value is HostConnectorBridge {
  return isRecord(value) && BRIDGE_MEMBERS.every((member) => typeof value[member] === "function")
}

export function hostConnectorBridge(scope: unknown = globalThis): HostConnectorBridge | undefined {
  const bridge = readUnknown(readUnknown(scope, "api"), "hostConnector")
  return isHostConnectorBridge(bridge) ? bridge : undefined
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
    // only the control plane holds, and reading it is not one of the
    // operations. Reported false rather than guessed.
    secondDeviceOpen: false,
    // The connector already reports what it publishes on every snapshot, so
    // this costs no extra channel. Main OMITS the field when the set is empty
    // (status-channel.ts spreads it conditionally), which is why absent reads
    // as `[]` here and not as "unknown": on this product the connector always
    // knows. A machine that is not enrolled publishes nothing, whatever a stale
    // snapshot still lists.
    sharedWorkspaceIds: enrolled ? [...(snapshot.sharedWorkspaceIds ?? [])] : [],
    // The only machine this product can name, and it can name it before the
    // first enrollment: the derivation reads this computer, not the account.
    // `devices` stays absent, so without this the Machines list would be empty
    // on the very computer the user is sitting at.
    ...(snapshot.displayName
      ? { machine: { displayName: snapshot.displayName, online: enrolled } }
      : {}),
  }
}

export function electronMachineRemoteAccess(bridge: HostConnectorBridge): MachineRemoteAccessPort {
  return {
    async status() {
      return machineRemoteAccessStatus(await bridge.status())
    },

    // `startAtLogin` is deliberately unread: the desktop's login item is set
    // through the platform descriptor's `setStartAtLogin`, which the controller
    // already calls beside this.
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

    async shareWorkspace(input) {
      const snapshot = await bridge.share(input)
      if (snapshot.status !== "enrolled") {
        throw new Error(snapshot.detail ?? `Remote access is not active (${snapshot.status})`)
      }
    },

    async unshareWorkspace(workspaceId) {
      const snapshot = await bridge.unshare({ workspaceId })
      if (snapshot.status !== "enrolled") {
        throw new Error(snapshot.detail ?? `Remote access is not active (${snapshot.status})`)
      }
    },

    /**
     * Rename this machine.
     *
     * `hostId` is not forwarded, for the same reason `revoke` ignores it: main
     * renames the enrollment the connector itself holds, so the only machine
     * this can name is the one the user is sitting at. The surface only ever
     * passes this machine's own id, because `devices` is absent here and
     * `status().machine` is the one row it can render.
     */
    async rename(input) {
      const snapshot = await bridge.rename({ displayName: input.displayName })
      if (snapshot.status !== "enrolled") {
        throw new Error(snapshot.detail ?? `Remote access is not active (${snapshot.status})`)
      }
      return { displayName: snapshot.displayName ?? input.displayName }
    },

    // `devices` stays absent here, as the port documents. Enumerating the
    // account's machines is not one of the closed operations; `status().machine`
    // answers for THIS machine, which is the only one this product knows.

    subscribe(listener) {
      return bridge.onStatus((snapshot) => listener(machineRemoteAccessStatus(snapshot)))
    },
  }
}
