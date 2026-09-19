import { describe, expect, test, vi } from "vitest"
import { serve } from "@hono/node-server"
import { once } from "node:events"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { RemoteAccessOwnerRoutes } from "./remote-access"

describe("remote access over the production Node HTTP adapter", () => {
  test("returns the authentication refusal without invoking workspace authority", async () => {
    const original = { Request: globalThis.Request, Response: globalThis.Response }
    const devices = vi.fn(async () => [])
    const app = RemoteAccessOwnerRoutes({
      deviceLoginConfigured: true,
      relayConfigured: true,
      authenticate: async () => { throw new ControlPlaneAuthError(401, "missing_bearer_token", "Sign in required") },
      service: {
        status: vi.fn(async () => ({ enabled: false, enrolled: false, secondDeviceOpen: false })),
        devices,
        revoke: vi.fn(async () => ({ revoked: false })),
        rename: vi.fn(async () => ({ displayName: "Renamed" })),
        markSecondDeviceOpen: vi.fn(async () => ({ recorded: false })),
      },
    })
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
    try {
      if (!server.listening) await once(server, "listening")
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("HTTP listener did not bind a port")
      const response = await fetch(`http://127.0.0.1:${address.port}/devices`)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
      expect(devices).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      globalThis.Request = original.Request
      globalThis.Response = original.Response
    }
  })
})
