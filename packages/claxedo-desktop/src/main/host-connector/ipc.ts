/**
 * The Host Connector's IPC surface: a closed set of named operations, and
 * nothing else.
 *
 * The desktop's sidecar serves no `/api/claxedo/remote-access/*` route, so the
 * renderer's Remote Access panel reaches the connector through this surface.
 * `status-channel.ts` is the other half of that conversation and stays
 * push-only; this is the half that comes IN.
 *
 * ## Why this is named operations and not one request
 *
 * Main holds two things the renderer must never be able to spend: the account
 * bearer, and a machine signing key that does not expire. A channel shaped
 * `hostedFetch(url, method, body)` — or anything that takes a path, a verb or
 * headers from the message — would make main a confused deputy, able to spend
 * both on any route the control plane exposes.
 * `account/hosted-operations.ts` states that rule for the account; it holds
 * here for the same reason and more sharply, and `ipc.test.ts` asserts the
 * shape rather than trusting this paragraph.
 *
 * Stronger than the account's version, in fact: no operation below names a
 * machine. `share`, `unshare` and `rename` carry DATA — a workspace id the
 * user picked, a name the user typed — and nothing else: there is no route to
 * substitute into, no body to fill and no machine to choose. A message picks
 * which fixed thing happens and, at most, to which of this machine's own
 * workspaces.
 *
 * ## What each operation means
 *
 *   - `status` — read. Never starts anything.
 *   - `start`  — publish this machine: mint or load the machine key, run the
 *     enrollment handshake, begin the heartbeat. THE user action. Nothing calls
 *     it at launch; `ipc-caller-guard.wiring.test.ts` pins that the entry never
 *     does, and it is registered here rather than in `index.ts` so that stays
 *     true by construction.
 *   - `pause`  — stop the heartbeat, keep the identity. The enrollment lapses
 *     when its TTL runs out, and a later `start` re-enrolls the same machine.
 *   - `revoke` — stop, and destroy the key. Nothing can heartbeat as this
 *     machine again; a later `start` enrolls an honest new one.
 *   - `share` / `unshare` — publish or withdraw one of this machine's own
 *     workspaces: the owner's assignment with the account, then the machine's
 *     ack on a beat.
 *   - `rename` — the owner's name for THIS machine. The enrollment it renames
 *     is the connector's own, read from its state here; the message carries a
 *     name and nothing that names a machine.
 *
 * These register through the same `ipcMain` the caller guard has already
 * wrapped, so every one of them is sender-checked. That ordering is enforced in
 * `index.ts`, which is where the knowledge of when this is called lives.
 */

import type { IpcMainInvokeEvent } from "electron"

import { readString, readUnknown } from "../../shared/json-read"
import type { HostConnectorSharedWorkspace } from "./child-protocol"
import type { HostConnectorStatus } from "./child-supervisor"
import { toStatusEvent, type HostConnectorContext, type HostConnectorStatusEvent } from "./status-channel"

/**
 * The closed set. Declared as data so the registration is generated from it and
 * a test can assert the whole surface without re-listing it by hand.
 */
export const HOST_CONNECTOR_OPERATIONS = ["status", "start", "pause", "revoke", "share", "unshare", "rename"] as const

export type HostConnectorOperation = (typeof HOST_CONNECTOR_OPERATIONS)[number]

/** One channel per operation, by name. Same convention as the account's. */
export function hostConnectorChannel(operation: HostConnectorOperation) {
  return `claxedo.hostConnector.${operation}`
}

/**
 * The registration surface, matching Electron's own so the real `ipcMain`
 * satisfies it. Type-only import, so this module stays loadable — and testable
 * — outside an Electron process.
 */
export type HostConnectorIpcTarget = {
  handle(channel: string, listener: HostConnectorIpcListener): unknown
}

/**
 * One listener shape for every channel. Declared here so the registration
 * below can pick its ARITY per operation without an assertion: only the
 * data-carrying operations declare a second parameter, and `ipc.test.ts`
 * asserts that.
 */
export type HostConnectorIpcListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

/**
 * What this surface needs from the connector.
 *
 * Narrower than `HostConnectorSetup` on purpose: the child supervisor also
 * exposes wiring the IPC layer has no business calling, and a parameter typed
 * as the whole thing is an invitation to reach for it.
 */
export type MachinePublication = {
  status: () => HostConnectorStatus
  start: () => Promise<HostConnectorStatus>
  /** Publish one workspace from this machine (owner assignment + machine consent). */
  shareWorkspace: (input: HostConnectorSharedWorkspace) => Promise<HostConnectorStatus>
  /** Withdraw one workspace: unassign at the control plane, drop consent. */
  unshareWorkspace: (workspaceId: string) => Promise<HostConnectorStatus>
  /** Stop beating, keep the identity. */
  stop: () => void
  /** Stop beating, destroy the identity. */
  revoke: () => void
  /** Rename this machine on the account, and remember the name. */
  renameMachine: (displayName: string) => Promise<{ displayName: string }>
}

export function registerHostConnectorIpc(input: {
  ipcMain: HostConnectorIpcTarget
  /**
   * Absent when this build has no account client configured.
   *
   * Registered anyway, so `status` answers `available: false` and the panel
   * says so. An unregistered channel would leave `window.api.hostConnector`
   * half-built, the renderer would treat the bridge as missing, and a desktop
   * would silently fall back to the browser implementation — a `fetch` to a
   * route its sidecar does not serve.
   */
  connector?: MachinePublication
  /**
   * The facts the connector's own state cannot carry: whether an account is
   * signed in (enrollment needs the owner's bearer) and the machine's name.
   * Read per call, because both change without this surface being told.
   */
  context: () => HostConnectorContext
  onError?: (stage: string, error: unknown) => void
}) {
  const { ipcMain, connector } = input
  const signedIn = () => input.context().signedIn
  const channels: string[] = []

  const snapshot = (override?: HostConnectorStatus): HostConnectorStatusEvent =>
    toStatusEvent(override ?? connector?.status() ?? { status: "not-started" }, {
      ...input.context(),
      available: connector !== undefined,
    })

  // `share` carries data, and deliberately only data: a workspace id and a
  // label. It still cannot DESCRIBE a request —
  // the route, the challenge flow, and the signature all live in main and the
  // child, so the confused-deputy rule above holds: a renderer picks which
  // fixed operation happens and, here, which workspace it happens to.
  const shareInput = (value: unknown): HostConnectorSharedWorkspace | undefined => {
    const workspaceId = readString(value, "workspaceId")
    if (!workspaceId) return undefined
    // A label of the wrong type rejects the whole share rather than being
    // silently dropped: the renderer does not get to send half a message.
    const displayName = readUnknown(value, "displayName")
    if (displayName !== undefined && typeof displayName !== "string") return undefined
    return { workspaceId, ...(displayName === undefined ? {} : { displayName }) }
  }

  const handlers: Record<HostConnectorOperation, (payload?: unknown) => Promise<HostConnectorStatusEvent>> = {
    status: async () => snapshot(),

    start: async () => {
      if (!connector) {
        return snapshot({ status: "stopped", reason: "error", detail: "This build cannot publish a machine" })
      }
      // Refused here rather than left to fail inside the handshake. Without a
      // bearer the nonce request comes back 401 and the panel would show a
      // transport error for what is really "sign in first".
      if (!signedIn()) {
        return snapshot({ status: "stopped", reason: "error", detail: "Sign in to publish this machine" })
      }
      try {
        return snapshot(await connector.start())
      } catch (error) {
        // The child supervisor already settles its own failures; this
        // catches an unknown escape, because in main an unhandled rejection
        // from an invoke handler leaves the renderer's promise pending forever
        // and the button spinning.
        input.onError?.("start", error)
        return snapshot({ status: "stopped", reason: "error", detail: String(error) })
      }
    },

    pause: async () => {
      connector?.stop()
      return snapshot()
    },

    revoke: async () => {
      connector?.revoke()
      return snapshot()
    },

    share: async (payload) => {
      if (!connector) {
        throw new Error("This build cannot publish a machine")
      }
      if (!signedIn()) {
        throw new Error("Sign in to share a workspace")
      }
      const share = shareInput(payload)
      if (!share) throw new Error("share requires a workspaceId")
      await connector.shareWorkspace(share)
      return snapshot()
    },

    rename: async (payload) => {
      if (!connector) {
        throw new Error("This build cannot publish a machine")
      }
      if (!signedIn()) {
        throw new Error("Sign in to rename this machine")
      }
      const displayName = readString(payload, "displayName")
      if (!displayName) throw new Error("rename requires a displayName")
      await connector.renameMachine(displayName)
      return snapshot()
    },

    unshare: async (payload) => {
      if (!connector) {
        throw new Error("This build cannot publish a machine")
      }
      if (!signedIn()) {
        throw new Error("Sign in to change shared workspaces")
      }
      const share = shareInput(payload)
      if (!share) throw new Error("unshare requires a workspaceId")
      await connector.unshareWorkspace(share.workspaceId)
      return snapshot()
    },
  }

  for (const operation of HOST_CONNECTOR_OPERATIONS) {
    const channel = hostConnectorChannel(operation)
    channels.push(channel)
    // The operation is bound HERE, at registration, and — except for the three
    // that declare a place to receive their data-only payload — the listener
    // takes no arguments: a renderer chooses which channel to call, not what
    // that channel does.
    const listener: HostConnectorIpcListener =
      operation === "share" || operation === "unshare" || operation === "rename"
        ? (_event, payload) => handlers[operation](payload)
        : () => handlers[operation]()
    ipcMain.handle(channel, listener)
  }

  return { channels }
}
