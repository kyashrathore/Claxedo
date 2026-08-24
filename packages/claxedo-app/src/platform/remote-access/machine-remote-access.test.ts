import { afterEach, describe, expect, test } from "bun:test"
import { configureMachineRemoteAccess, machineRemoteAccess, resetMachineRemoteAccess } from "./machine-remote-access"
import type { MachineRemoteAccessPort } from "./machine-remote-access-port"

function stub(label: string): MachineRemoteAccessPort {
  return {
    status: async () => ({
      deviceLoginConfigured: true,
      relayConfigured: true,
      hostedSignedIn: true,
      enrolled: false,
      enabled: false,
      secondDeviceOpen: false,
    }),
    enable: async () => {
      throw new Error(label)
    },
    revoke: async () => ({ revoked: false }),
  }
}

afterEach(() => resetMachineRemoteAccess())

describe("machine remote access binding", () => {
  test("is absent until a composition root binds one", () => {
    // `app/entry/local.tsx` binds nothing: `@claxedo/local-server` serves no
    // remote-access route and there is no Electron main under it. Absent is the
    // answer, and the surface renders it as a locked panel.
    expect(machineRemoteAccess()).toBeUndefined()
  })

  test("hands back the port the last root bound", async () => {
    configureMachineRemoteAccess(stub("first"))
    await expect(machineRemoteAccess()?.enable({ displayName: "a", startAtLogin: false })).rejects.toThrow("first")

    configureMachineRemoteAccess(stub("second"))
    await expect(machineRemoteAccess()?.enable({ displayName: "a", startAtLogin: false })).rejects.toThrow("second")
  })
})
