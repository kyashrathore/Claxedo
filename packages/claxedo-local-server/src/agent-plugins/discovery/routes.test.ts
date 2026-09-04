import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import { MachineInstalledDiscoveryRoutes } from "./routes"

describe("MachineInstalledDiscoveryRoutes", () => {
  test("GET / returns the { harnesses } shape for claude, cursor and codex, machine-wide (never throws)", async () => {
    const app = new Hono()
    app.route("/machine-installed", MachineInstalledDiscoveryRoutes())

    const response = await app.request("http://local.test/machine-installed")
    expect(response.status).toBe(200)
    const body = await response.json() as unknown
    expect(body).toMatchObject({
      harnesses: [
        { harnessId: "claude", entries: expect.any(Array) },
        { harnessId: "cursor", entries: expect.any(Array) },
        { harnessId: "codex", entries: expect.any(Array) },
      ],
    })
  })
})
