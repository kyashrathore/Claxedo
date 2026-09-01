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
      onStatus: () => () => {},
    }

    expect(configureDesktopMachineRemoteAccess({ api: { hostConnector: bridge } })).toBe(true)
    await machineRemoteAccess()?.enable({ displayName: "Mac", startAtLogin: false })

    expect(calls).toEqual(["start"])
    // `devices` is the connector's own snapshot projected as one machine —
    // present, and never a request beyond the bridge's status read.
    expect(machineRemoteAccess()?.devices).toBeDefined()
  })

  test("binds nothing when preload exposes no bridge", () => {
    expect(configureDesktopMachineRemoteAccess({})).toBe(false)
    expect(machineRemoteAccess()).toBeUndefined()
  })
})
