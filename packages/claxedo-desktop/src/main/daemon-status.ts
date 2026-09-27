/**
 * What the renderer is told when the local daemon goes away under it.
 *
 * Two facts arrive separately and in no fixed order: the lease connection
 * closing, which is all an adopted daemon can report, and the exit of a daemon
 * this process started, which carries its code or signal. Either one means the
 * daemon is lost; an exit arriving after the lease replaces the status so the
 * renderer can say why.
 *
 * Nothing here restarts anything. The renderer's restart goes through the
 * existing `relaunch` channel and `runRestart`, and `restart` names what that
 * channel will do in this build so the renderer can label it truthfully.
 */

import type { RestartBehavior } from "../shared/restart-policy"

export const DAEMON_STATUS_CHANNELS = {
  read: "claxedo.daemon.status",
  changed: "claxedo.daemon.statusChanged",
} as const

export type DaemonExit = { code: number | null; signal: string | null }

export type DaemonStatus =
  | { kind: "running" }
  | { kind: "lost"; restart: RestartBehavior; exit?: DaemonExit }

type StatusTarget = {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: unknown) => void }
}

export function createDaemonStatus(input: { restart: RestartBehavior; target: () => StatusTarget | undefined }) {
  let status: DaemonStatus = { kind: "running" }
  const publish = (next: DaemonStatus) => {
    status = next
    const target = input.target()
    if (!target || target.isDestroyed()) return
    target.webContents.send(DAEMON_STATUS_CHANNELS.changed, next)
  }
  return {
    current: () => status,
    leaseLost() {
      if (status.kind === "lost") return
      publish({ kind: "lost", restart: input.restart })
    },
    exited(exit: DaemonExit) {
      publish({ kind: "lost", restart: input.restart, exit })
    },
  }
}
