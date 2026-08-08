/**
 * The Host Connector's IPC surface: four named operations, and nothing else.
 *
 * The renderer's Remote Access panel needs to DO something — the desktop's
 * sidecar stopped serving `/api/claxedo/remote-access/*` when machine
 * publication moved here, so "Enable remote access" has no route to call and
 * must reach the connector instead. `status-channel.ts` is the other half of
 * that conversation and stays push-only; this is the half that comes IN.
 *
 * ## Why this is four named operations and not one request
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
 * Stronger than the account's version, in fact: every operation below takes NO
 * ARGUMENTS AT ALL. There is no id to substitute, no body to fill and no label
 * to choose, so there is nothing in an incoming message for a handler to act
 * on. A message can pick which of four things happens; it cannot describe one.
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
 *
 * These register through the same `ipcMain` the caller guard has already
 * wrapped, so every one of them is sender-checked. That ordering is enforced in
 * `index.ts`, which is where the knowledge of when this is called lives.
 */

import type { IpcMainInvokeEvent } from "electron"
import type { HostConnectorStatus } from "./index"
import { toStatusEvent, type HostConnectorStatusEvent } from "./status-channel"

/**
 * The closed set. Declared as data so the registration is generated from it and
 * a test can assert the whole surface without re-listing it by hand.
 */
export const HOST_CONNECTOR_OPERATIONS = ["status", "start", "pause", "revoke"] as const

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
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown
}

/**
 * What this surface needs from the connector.
 *
 * Narrower than `HostConnectorSetup` on purpose: `setupHostConnector` also
 * exposes wiring the IPC layer has no business calling, and a parameter typed
 * as the whole thing is an invitation to reach for it.
 */
export type MachinePublication = {
  status: () => HostConnectorStatus
  start: () => Promise<HostConnectorStatus>
  /** Stop beating, keep the identity. */
  stop: () => void
  /** Stop beating, destroy the identity. */
  revoke: () => void
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
   * route its sidecar does not serve, which is the bug this replaces.
   */
  connector?: MachinePublication
  /** Whether an account is signed in. Enrollment needs the owner's bearer. */
  signedIn: () => boolean
  onError?: (stage: string, error: unknown) => void
}) {
  const { ipcMain, connector, signedIn } = input
  const channels: string[] = []

  const snapshot = (override?: HostConnectorStatus): HostConnectorStatusEvent =>
    toStatusEvent(override ?? connector?.status() ?? { status: "not-started" }, {
      available: connector !== undefined,
      signedIn: signedIn(),
    })

  const handlers: Record<HostConnectorOperation, () => Promise<HostConnectorStatusEvent>> = {
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
        // `setupHostConnector.start` already settles its own failures; this
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
  }

  for (const operation of HOST_CONNECTOR_OPERATIONS) {
    const channel = hostConnectorChannel(operation)
    channels.push(channel)
    // The operation is bound HERE, at registration, and the listener takes no
    // arguments. A renderer chooses which channel to call; it cannot choose
    // what that channel does, and it cannot hand the channel anything to act
    // on.
    ipcMain.handle(channel, (() => handlers[operation]()) as never)
  }

  return { channels }
}
