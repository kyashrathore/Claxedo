import { afterEach, describe, expect, test } from "bun:test"
import { createIntegrationsRequest } from "./integrations-request"

type Bridge = { api?: { account?: Record<string, unknown> } }
const host = globalThis as Bridge

function installSignedBridge(run: (operation: string, input?: Record<string, unknown>) => Promise<unknown>) {
  host.api = {
    account: {
      state: async () => ({ status: "signed" }),
      onState: () => () => {},
      signIn: async () => undefined,
      signOut: async () => undefined,
      run,
    },
  }
}

afterEach(() => {
  delete host.api
})

describe("integrations request on a signed desktop", () => {
  test("the root list is a DECODED operation, re-wrapped as a 200 Response", async () => {
    // Electron main returns the body itself for `connections.list` (no
    // `{ status, body }` envelope). Consumers must read it as a Response.
    const operations: string[] = []
    installSignedBridge(async (operation) => {
      operations.push(operation)
      return { connections: [{ id: "c1", integrationId: "composio", scope: "personal", status: "connected" }] }
    })
    const response = await createIntegrationsRequest("http://cp.test")("")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      connections: [{ id: "c1", integrationId: "composio", scope: "personal", status: "connected" }],
    })
    expect(operations).toEqual(["connections.list"])
  })

  test("a hosted HTTP failure becomes a Response with the server's status and body", async () => {
    installSignedBridge(async () => {
      throw new Error('HOSTED_HTTP 404 {"detail":"gone","body":{"error":{"code":"not_found","message":"no such connection"}}}')
    })
    const response = await createIntegrationsRequest("http://cp.test")("/connections/c9", { method: "DELETE" })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "no such connection" } })
  })
})
