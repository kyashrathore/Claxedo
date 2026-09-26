import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"
import { createOpenCodeRuntime, type OpenCodeRuntime } from "./runtime"
import type { ProviderDefinition } from "./provider-definition"
import { WorkspaceScope } from "./scope"

type Recorded = { path: string; authorization?: string; tenant?: string; model: unknown }

function recordingEndpoint() {
  const requests: Recorded[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { model?: unknown }
    const tenant = request.headers["x-acme-tenant"]
    requests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof tenant === "string" ? { tenant } : {}),
      model: body.model,
    })
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const delta of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "answered" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]) response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "m", ...delta })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  return {
    requests,
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
      const address = server.address()
      return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function engine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-provider-definition-"))
  const directory = path.join(root, "work")
  fs.mkdirSync(directory)
  const runtime = createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db") })
  cleanups.push(async () => {
    await runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { runtime, scope: WorkspaceScope.authorize({ workspaceID: "w", directory }) }
}

async function endpoint() {
  const recorder = recordingEndpoint()
  const url = await recorder.listen()
  cleanups.push(() => recorder.close())
  return { ...recorder, url }
}

function acme(baseURL: string, overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return {
    id: "acme",
    name: "Acme",
    baseURL,
    headers: { "X-Acme-Tenant": "prod" },
    models: { "acme-1": { name: "Acme One" } },
    env: [],
    enabled: true,
    ...overrides,
  }
}

async function listed(runtime: OpenCodeRuntime, scope: WorkspaceScope) {
  return (await runtime.catalog.models(scope)).filter((model) => model.providerID === "acme").map((model) => model.id)
}

async function turn(runtime: OpenCodeRuntime, scope: WorkspaceScope, until: () => boolean) {
  const session = await runtime.sessions.create(scope, { title: "custom provider" })
  await runtime.sessions.switchModel(scope, session.id, { providerID: "acme", modelID: "acme-1" })
  await runtime.sessions.prompt(scope, session.id, { text: "say hello" })
  for (let wait = 0; wait < 300 && !until(); wait++) await new Promise((resolve) => setTimeout(resolve, 50))
}

test("a declared provider is listed and a turn on it reaches its endpoint with its headers", async () => {
  const upstream = await endpoint()
  const { runtime, scope } = engine()
  expect(await listed(runtime, scope)).toEqual([])

  await runtime.defineProviders([acme(upstream.url)])

  expect(await listed(runtime, scope)).toEqual(["acme-1"])
  await turn(runtime, scope, () => upstream.requests.length > 0)
  expect(upstream.requests[0]).toMatchObject({ path: "/v1/chat/completions", tenant: "prod", model: "acme-1" })
}, 60_000)

test("a declared provider that is switched off is not listed", async () => {
  const upstream = await endpoint()
  const { runtime, scope } = engine()

  await runtime.defineProviders([acme(upstream.url, { enabled: false })])

  expect(await listed(runtime, scope)).toEqual([])
}, 30_000)

test("a provider left out of the next set is no longer listed", async () => {
  const upstream = await endpoint()
  const { runtime, scope } = engine()
  await runtime.defineProviders([acme(upstream.url)])
  expect(await listed(runtime, scope)).toEqual(["acme-1"])

  await runtime.defineProviders([])

  expect(await listed(runtime, scope)).toEqual([])
}, 30_000)

test("a bound declared provider sends to its binding with the placeholder, never to its endpoint", async () => {
  const upstream = await endpoint()
  const broker = await endpoint()
  const { runtime, scope } = engine()

  await runtime.defineProviders([acme(upstream.url)])
  await runtime.bindProviders({ overlays: { acme: { baseURL: broker.url, apiKey: "broker-placeholder" } }, unbound: "engine" })
  await turn(runtime, scope, () => broker.requests.length > 0)

  expect(broker.requests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer broker-placeholder", tenant: "prod" })
  expect(upstream.requests).toEqual([])
}, 60_000)

test("the provider's own variable supplies its key", async () => {
  const upstream = await endpoint()
  const { runtime, scope } = engine()
  const name = "CLAXEDO_CUSTOM_PROVIDER_ACME_API_KEY"
  process.env[name] = "sk-from-env"
  cleanups.push(async () => { delete process.env[name] })

  await runtime.defineProviders([acme(upstream.url, { env: [name] })])
  await turn(runtime, scope, () => upstream.requests.length > 0)

  expect(upstream.requests[0]?.authorization).toBe("Bearer sk-from-env")
}, 60_000)
