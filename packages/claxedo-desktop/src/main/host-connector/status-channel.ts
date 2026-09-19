/**
 * How the renderer learns what the machine's remote access is doing.
 *
 * PUSH, not invoke. The connector's state changes from a heartbeat timer main
 * owns — an enrollment expires, a beat is rejected, the control plane revokes.
 * A renderer that had to ask would only find out when it happened to ask, and
 * the Remote Access panel's whole job is showing a state the user did not
 * cause.
 *
 * READ-ONLY. Nothing here can be called; `ipc.ts` owns the named operations
 * the renderer may ask for, and it registers them through the
 * caller-guarded `ipcMain`. This file registers no `ipcMain.handle` at all and
 * so has nothing for the guard to wrap: main→renderer sends are not calls INTO
 * main. Keeping the two directions in two files is what makes "does the
 * renderer reach this?" answerable by looking at one of them.
 *
 * The projection below is shared with `ipc.ts`, deliberately: a push and an
 * invoke that answered with different shapes would give the panel two versions
 * of the same fact, and the one that arrived second would win.
 */

import type { HostConnectorStatus } from "./child-supervisor"

export const HOST_CONNECTOR_STATUS_CHANNEL = "claxedo.hostConnector.status"

/** The webContents this pushes to. Narrowed so tests need no BrowserWindow. */
export type StatusTarget = {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: unknown) => void }
}

/**
 * What the renderer receives.
 *
 * A projection of the connector's state, not the state object. The connector's
 * own shape carries an enrollment record; the panel needs a status, a reason
 * and an expiry, and sending more would put fields on the boundary that no
 * surface reads and every future reader would be tempted to. The enrollment id
 * and the HOST ID stay behind: they name the machine to the control plane, and
 * no panel needs to say a machine's name back to it.
 */
export type HostConnectorStatusEvent = {
  status: string
  reason?: string
  detail?: string
  expiresAt?: number
  /**
   * Workspaces this machine currently publishes. Carried so the Remote
   * Access panel can show live share state without a route the desktop's
   * sidecar does not serve; ids only — the host id itself stays behind.
   */
  sharedWorkspaceIds?: readonly string[]
  /** Whether this build can publish a machine at all. */
  available: boolean
  /** Whether an account is signed in. */
  signedIn: boolean
  /**
   * The name this machine is published under.
   *
   * The one fact about the machine's identity the panel does get, because it
   * is the only one a person reads: the desktop cannot enumerate the account's
   * machines, so without it the Machines list would be empty on the computer
   * the user is sitting at. The host id and the enrollment id still stay
   * behind — a rename names no machine over IPC, main takes the id from the
   * connector's own state.
   */
  displayName?: string
}

/**
 * The two facts the connector's own state cannot carry.
 *
 * `available` is a property of the BUILD — whether an account client was
 * configured at all — `signedIn` belongs to the account service, and the
 * machine's name is derived in main from this computer, or stored there from
 * an owner's rename. All three are read by the same panel that reads the
 * connector's state, and a panel that had to combine four sources would
 * combine them differently in each of its callers.
 */
export type HostConnectorContext = {
  available: boolean
  signedIn: boolean
  displayName?: string
}

export function toStatusEvent(state: HostConnectorStatus, context: HostConnectorContext): HostConnectorStatusEvent {
  const record = state as {
    status: string
    reason?: string
    detail?: string
    enrollment?: { expires_at?: number }
    sharedWorkspaceIds?: readonly string[]
  }
  return {
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.enrollment?.expires_at ? { expiresAt: record.enrollment.expires_at } : {}),
    ...(record.sharedWorkspaceIds ? { sharedWorkspaceIds: record.sharedWorkspaceIds } : {}),
    available: context.available,
    signedIn: context.signedIn,
    ...(context.displayName ? { displayName: context.displayName } : {}),
  }
}

/**
 * Push status to a window, skipping ones that have gone.
 *
 * A destroyed webContents throws on `send`, and this runs from a timer — so an
 * unchecked send turns a closed window into a repeating crash in the main
 * process rather than a no-op.
 */
export function publishHostConnectorStatus(
  target: StatusTarget | undefined,
  state: HostConnectorStatus,
  context: HostConnectorContext,
) {
  if (!target || target.isDestroyed()) return false
  target.webContents.send(HOST_CONNECTOR_STATUS_CHANNEL, toStatusEvent(state, context))
  return true
}
