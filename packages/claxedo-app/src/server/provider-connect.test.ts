/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createProviderConnectApi } from "./provider-connect"
import { createTransport } from "./transport"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function serve() {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      seen.push(`${request.method} ${url.pathname}${url.search}${text ? ` ${text}` : ""}`)
      return Response.json({ ok: true })
    },
  })
  running.push(server)
  return { seen, api: createProviderConnectApi(createTransport({ serverUrl: `http://127.0.0.1:${server.port}` }), new QueryClient()) }
}

test("provider connect: a custom provider is declared with the header its key rides in", async () => {
  const { seen, api } = serve()
  await api.saveCustomProvider({
    config: { providerId: "acme", name: "Acme", baseURL: "https://api.acme.test/v1", env: [], headers: { "X-Title": "Claxedo" }, credentialHeader: { name: "x-api-key" }, models: { "acme-1": { name: "Acme One" } } },
  })
  expect(seen).toEqual([
    'PUT /api/claxedo/agent-config/providers/custom?nativeHarness=opencode {"providerID":"acme","name":"Acme","baseURL":"https://api.acme.test/v1","env":[],"headers":{"X-Title":"Claxedo"},"credentialHeader":{"name":"x-api-key"},"models":{"acme-1":{"name":"Acme One"}}}',
  ])
})

test("provider connect: disconnecting a custom provider drops its declaration, and any other provider its auth entry", async () => {
  const { seen, api } = serve()
  await api.disconnect("opencode", { id: "acme", source: "custom" })
  await api.disconnect("opencode", { id: "openrouter", source: "api" })
  expect(seen).toEqual([
    "DELETE /api/claxedo/credentials/provider/acme",
    "DELETE /api/claxedo/agent-config/providers/custom/acme?nativeHarness=opencode",
    "DELETE /api/claxedo/credentials/provider/openrouter",
    "DELETE /auth/openrouter?harness=opencode",
  ])
})
