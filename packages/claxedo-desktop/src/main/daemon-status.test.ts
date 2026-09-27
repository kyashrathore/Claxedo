import { describe, expect, test } from "bun:test"
import { createDaemonStatus, DAEMON_STATUS_CHANNELS } from "./daemon-status"

function window() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let destroyed = false
  return {
    sent,
    destroy: () => (destroyed = true),
    target: {
      isDestroyed: () => destroyed,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    },
  }
}

describe("daemon status", () => {
  test("a closed lease publishes the daemon as lost once, with the restart this build performs", () => {
    const win = window()
    const status = createDaemonStatus({ restart: "relaunch", target: () => win.target })
    expect(status.current()).toEqual({ kind: "running" })

    status.leaseLost()
    status.leaseLost()

    expect(status.current()).toEqual({ kind: "lost", restart: "relaunch" })
    expect(win.sent).toEqual([{ channel: DAEMON_STATUS_CHANNELS.changed, payload: { kind: "lost", restart: "relaunch" } }])
  })

  test("the child's exit names the cause whether it lands before or after the lease closes", () => {
    const exit = { code: null, signal: "SIGKILL" }
    const leaseFirst = window()
    const afterLease = createDaemonStatus({ restart: "reload", target: () => leaseFirst.target })
    afterLease.leaseLost()
    afterLease.exited(exit)
    expect(afterLease.current()).toEqual({ kind: "lost", restart: "reload", exit })
    expect(leaseFirst.sent.at(-1)?.payload).toEqual({ kind: "lost", restart: "reload", exit })

    const exitFirst = window()
    const beforeLease = createDaemonStatus({ restart: "reload", target: () => exitFirst.target })
    beforeLease.exited(exit)
    beforeLease.leaseLost()
    expect(beforeLease.current()).toEqual({ kind: "lost", restart: "reload", exit })
    expect(exitFirst.sent).toHaveLength(1)
  })

  test("a window that has gone is skipped, and the status is still there to read", () => {
    const win = window()
    win.destroy()
    const status = createDaemonStatus({ restart: "relaunch", target: () => win.target })
    status.leaseLost()
    expect(win.sent).toEqual([])
    expect(status.current()).toEqual({ kind: "lost", restart: "relaunch" })

    const noWindow = createDaemonStatus({ restart: "relaunch", target: () => undefined })
    noWindow.exited({ code: 1, signal: null })
    expect(noWindow.current()).toEqual({ kind: "lost", restart: "relaunch", exit: { code: 1, signal: null } })
  })
})
