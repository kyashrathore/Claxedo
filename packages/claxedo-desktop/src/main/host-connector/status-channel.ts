/**
 * How the renderer learns what the machine's remote access is doing.
 *
 * PUSH, not invoke. The connector's state changes from a heartbeat timer main
 * owns — an enrollment expires, a beat is rejected, the control plane revokes.
 * A renderer that had to ask would only find out when it happened to ask, and
 * the Remote Access panel's whole job is showing a state the user did not
 * cause.
 *
 * READ-ONLY. There is no channel here to start, pause or resume anything.
 * Pausing is an account-authorized operation and belongs on the account's named
 * operations, where the credential is; a channel that let the renderer drive a
 * signing process would be a second, weaker path to the same authority.
 *
 * That asymmetry is why this file registers no `ipcMain.handle` at all and so
 * has nothing for the caller guard to wrap: main→renderer sends are not calls
 * INTO main. The guard covers the direction that matters.
 */

import type { HostConnectorStatus } from "./index"

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
 * surface reads and every future reader would be tempted to.
 */
export type HostConnectorStatusEvent = {
  status: string
  reason?: string
  detail?: string
  expiresAt?: number
}

export function toStatusEvent(state: HostConnectorStatus): HostConnectorStatusEvent {
  const record = state as { status: string; reason?: string; detail?: string; enrollment?: { expires_at?: number } }
  return {
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.enrollment?.expires_at ? { expiresAt: record.enrollment.expires_at } : {}),
  }
}

/**
 * Push status to a window, skipping ones that have gone.
 *
 * A destroyed webContents throws on `send`, and this runs from a timer — so an
 * unchecked send turns a closed window into a repeating crash in the main
 * process rather than a no-op.
 */
export function publishHostConnectorStatus(target: StatusTarget | undefined, state: HostConnectorStatus) {
  if (!target || target.isDestroyed()) return false
  target.webContents.send(HOST_CONNECTOR_STATUS_CHANNEL, toStatusEvent(state))
  return true
}
