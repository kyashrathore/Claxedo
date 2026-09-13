import { expect, test } from "vitest"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import { createControlPlaneServices } from "../../authority/services"
import { createSelfHostedApp } from "./app"

/**
 * The self-hosted composition serves the same credential proxy the desktop
 * does, and a container binds `0.0.0.0`: without the peer check here the
 * broker answers the whole network, and the runtime token is the only thing
 * between that network and the operator's stored keys.
 *
 * Mirrors `claxedo-local-server/src/app/local-app.behaviour.test.ts`'s
 * "local egress broker hosting" block, request for request.
 */
function createTestApp(options: Parameters<typeof createSelfHostedApp>[1] = {}) {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createSelfHostedApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { authority: testManagedSessionAuthority(), localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
    options,
  ).app
}

test("a loopback peer reaches the broker", async () => {
  const tokens: string[] = []
  const app = createTestApp({ egressBroker: async (request) => {
    tokens.push(request.headers.get("authorization")!.slice(7))
    return new Response(null, { status: 401 })
  } })
  const response = await app.request("http://127.0.0.1/bindings/b1/v1/messages", {
    headers: { authorization: "Bearer runtime-token" },
  })
  expect(response.status).toBe(401)
  expect(tokens).toEqual(["runtime-token"])
})

test("a non-loopback peer is refused before the broker is consulted", async () => {
  const tokens: string[] = []
  const app = createTestApp({ egressBroker: async (request) => {
    tokens.push(request.headers.get("authorization")!.slice(7))
    return new Response(null, { status: 401 })
  } })
  const response = await app.request("https://control.example/bindings/b1/v1/messages", {
    headers: { authorization: "Bearer runtime-token" },
  })
  expect(response.status).toBe(403)
  expect(tokens).toEqual([])
})

test("no cross-origin read is granted to the binding path", async () => {
  const app = createTestApp({ egressBroker: async () => new Response(null, { status: 401 }) })
  const response = await app.request("http://127.0.0.1/bindings/b1/v1/messages", {
    headers: { authorization: "Bearer runtime-token", origin: "http://localhost:3000" },
  })
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})
