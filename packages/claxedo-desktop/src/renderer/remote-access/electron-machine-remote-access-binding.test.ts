import { afterEach, describe, expect, test } from "bun:test"
import {
  machineRemoteAccess,
  resetMachineRemoteAccess,
} from "@/platform/remote-access/machine-remote-access"
import { configureDesktopMachineRemoteAccess } from "./electron-machine-remote-access-binding"

afterEach(() => resetMachineRemoteAccess())

describe("desktop machine remote-access binding", () => {
  test("reaches the Host Connector and issues no request", async () => {
    const calls: string[] = []
    const snapshot = { status: "enrolled", available: true, signedIn: true }
    const bridge = {
      status: async () => snapshot,
      start: async () => {
        calls.push("start")
        return snapshot
      },
      pause: async () => snapshot,
      revoke: async () => snapshot,
      share: async () => snapshot,
      unshare: async () => snapshot,
      rename: async () => snapshot,
      onStatus: () => () => {},
    }

    expect(configureDesktopMachineRemoteAccess({ api: { hostConnector: bridge } })).toBe(true)
    await machineRemoteAccess()?.enable({ startAtLogin: false })

    expect(calls).toEqual(["start"])
    // The account-wide device list is not one of the closed operations, so the
    // bound port leaves it absent; the one machine it does know about is
    // reported on `status()` instead.
    expect(machineRemoteAccess()?.devices).toBeUndefined()
  })

  test("binds nothing when preload exposes no bridge", () => {
    expect(configureDesktopMachineRemoteAccess({})).toBe(false)
    expect(machineRemoteAccess()).toBeUndefined()
  })
})
