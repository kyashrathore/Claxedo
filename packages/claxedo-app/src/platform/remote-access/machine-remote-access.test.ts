import { afterEach, describe, expect, test } from "bun:test"
import {
  configureDesktopMachineRemoteAccess,
  configureHttpMachineRemoteAccess,
  configureMachineRemoteAccess,
  machineRemoteAccess,
  resetMachineRemoteAccess,
} from "./machine-remote-access"
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

describe("which mechanism each product binds", () => {
  test("the HTTP root reaches the routes its own server serves", async () => {
    const calls: string[] = []
    configureHttpMachineRemoteAccess(async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`)
      return Response.json({ host_id: "h", connection_count: 0 })
    })

    await machineRemoteAccess()?.enable({ displayName: "Mac", startAtLogin: false })

    expect(calls).toEqual(["POST /api/claxedo/remote-access/enable"])
  })

  test("the desktop root reaches the Host Connector, and issues no request", async () => {
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
      onStatus: () => () => {},
    }

    expect(configureDesktopMachineRemoteAccess({ api: { hostConnector: bridge } })).toBe(true)
    await machineRemoteAccess()?.enable({ displayName: "Mac", startAtLogin: false })

    expect(calls).toEqual(["start"])
    // The tell that it is the Electron port and not the HTTP one: enumerating
    // the account's machines is not one of the four operations.
    expect(machineRemoteAccess()?.devices).toBeUndefined()
  })

  test("the desktop root binds NOTHING when the preload exposes no bridge", () => {
    // Never a fall back to HTTP. The desktop's sidecar serves none of those
    // routes, so a fallback would post into a 404 — the regression, returning
    // dressed as resilience.
    expect(configureDesktopMachineRemoteAccess({})).toBe(false)
    expect(machineRemoteAccess()).toBeUndefined()
  })
})
