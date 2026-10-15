/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createProviderConnectApi } from "./provider-connect"
import { queryKeys } from "./query-keys"
import { createTransport } from "./transport"

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function serve(deleted = 1) {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      seen.push(`${request.method} ${url.pathname}${url.search}${text ? ` ${text}` : ""}`)
      return Response.json(request.method === "DELETE" && url.pathname.startsWith("/api/claxedo/credentials/") ? { deleted } : { ok: true })
    },
  })
  running.push(server)
  const serverUrl = `http://127.0.0.1:${server.port}`
  const client = new QueryClient()
  return { seen, serverUrl, client, api: createProviderConnectApi(createTransport({ serverUrl }), client) }
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

test("provider connect: a pasted secret is saved under its method's kind, so the server can refuse a subscription token that is not one", async () => {
  const { seen, api } = serve()
  await api.saveKey({ providerId: "claude-sdk", label: "me", secret: "sk-ant-oat01-setup", kind: "oauth_token" })
  await api.saveKey({ providerId: "anthropic", label: "me", secret: "sk-ant-api03-key", kind: "api_key" })
  expect(seen).toEqual([
    'PUT /api/claxedo/credentials {"provider_id":"claude-sdk","kind":"oauth_token","source":"managed","label":"me","secret":"sk-ant-oat01-setup"}',
    'PUT /api/claxedo/credentials {"provider_id":"anthropic","kind":"api_key","source":"managed","label":"me","secret":"sk-ant-api03-key"}',
  ])
})

test("provider connect: disconnecting removes the provider's own account, and a custom provider's declaration too", async () => {
  const { seen, api } = serve()
  await api.disconnect("opencode", { id: "acme", source: "custom" })
  await api.disconnect("opencode", { id: "openrouter", source: "api" })
  await api.disconnect("pi", { id: "anthropic", source: "api" })
  expect(seen).toEqual([
    "DELETE /api/claxedo/credentials/provider/acme",
    "DELETE /api/claxedo/agent-config/providers/custom/acme?nativeHarness=opencode",
    "DELETE /api/claxedo/credentials/provider/openrouter",
    "DELETE /api/claxedo/credentials/provider/anthropic",
  ])
})

test("provider connect: a disconnect that removed no account of yours fails instead of reporting success", async () => {
  const { seen, api } = serve(0)
  await expect(api.disconnect("pi", { id: "anthropic", source: "api" })).rejects.toMatchObject({ class: "not_found" })
  await api.disconnect("opencode", { id: "acme", source: "custom" })
  expect(seen).toEqual([
    "DELETE /api/claxedo/credentials/provider/anthropic",
    "DELETE /api/claxedo/credentials/provider/acme",
    "DELETE /api/claxedo/agent-config/providers/custom/acme?nativeHarness=opencode",
  ])
})

test("provider connect: a refused disconnect rereads the accounts, so a row another tab already removed corrects itself", async () => {
  const { serverUrl, client, api } = serve(0)
  client.setQueryData(queryKeys.accounts(serverUrl), [])
  await expect(api.disconnect("pi", { id: "groq", source: "api" })).rejects.toMatchObject({ class: "not_found" })
  expect(client.getQueryState(queryKeys.accounts(serverUrl))?.isInvalidated).toBe(true)
})
