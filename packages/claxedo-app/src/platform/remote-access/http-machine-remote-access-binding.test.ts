import { afterEach, describe, expect, test } from "bun:test"
import { configureHttpMachineRemoteAccess } from "./http-machine-remote-access-binding"
import { machineRemoteAccess, resetMachineRemoteAccess } from "./machine-remote-access"

afterEach(() => resetMachineRemoteAccess())

describe("HTTP machine remote-access binding", () => {
  test("the HTTP root reaches the routes its own server serves", async () => {
    const calls: string[] = []
    configureHttpMachineRemoteAccess(async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`)
      return Response.json({ host_id: "h", connection_count: 0 })
    })

    await machineRemoteAccess()?.enable({ displayName: "Mac", startAtLogin: false })

    expect(calls).toEqual(["POST /api/claxedo/remote-access/enable"])
  })
})
