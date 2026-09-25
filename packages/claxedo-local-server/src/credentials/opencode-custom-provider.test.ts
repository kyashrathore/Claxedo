/**
 * A custom OpenCode provider from its stored row to a turn's request: the real
 * registry, the real loopback broker, the process's own engine and the served
 * catalog, with only the vendor replaced by a recording endpoint.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"

const dataDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-custom-provider-engine-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = dataDir

const [
  { putCustomProvider },
  { putCredential },
  { createTestBackend, setBackendOverride },
  { configureAgentConfig, disposeAgentConfig },
  { opencodeProviderCatalog },
  { openCodeEngineModels, openCodeSdkRuntime, drainOpenCodeSdkRuntime },
  { WorkspaceScope },
  { OpenCodeSdkHarnessAdapter },
  { createLocalCredentialBroker },
  { ClaxedoDB },
] = await Promise.all([
  import("@claxedo/server-core/credentials/custom-provider"),
  import("@claxedo/server-core/credentials/registry"),
  import("@claxedo/server-core/credentials/backend-registry"),
  import("@claxedo/server-core/agent-config/index"),
  import("@claxedo/server-core/credentials/opencode-provider-catalog"),
  import("@claxedo/server-core/opencode/sdk-runtime"),
  import("@claxedo/harness/opencode-sdk"),
  import("@claxedo/workspace-runtime/testing"),
  import("./broker"),
  import("@claxedo/server-core/platform/db/index"),
])

type Recorded = { path: string; authorization?: string; tenant?: string }
const upstreamRequests: Recorded[] = []
let upstream: Server
let brokerServer: Server

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
}

beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    for await (const _ of request) void _
    const tenant = request.headers["x-acme-tenant"]
    upstreamRequests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof tenant === "string" ? { tenant } : {}),
    })
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const delta of [
      { choices: [{ index: 0, delta: { role: "assistant", content: "answered" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]) response.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "acme-1", ...delta })}\n\n`)
    response.end("data: [DONE]\n\n")
  })
  const upstreamOrigin = await listen(upstream)

  // The broker is a route on the server's own loopback listener; this one
  // serves nothing else.
  let handler: (request: Request) => Promise<Response> = async () => new Response(null, { status: 503 })
  brokerServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value)
    const answer = await handler(new Request(`http://127.0.0.1${request.url}`, {
      method: request.method,
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }))
    response.writeHead(answer.status, Object.fromEntries(answer.headers))
    response.end(Buffer.from(await answer.arrayBuffer()))
  })
  const brokerOrigin = await listen(brokerServer)
  const broker = createLocalCredentialBroker({ dataDir, brokerOrigin })
  handler = broker.handler
  configureAgentConfig({ projectAuth: (input) => broker.projectAuth(input) })

  setBackendOverride(createTestBackend())
  putCustomProvider({
    providerID: "acme",
    name: "Acme",
    baseURL: `${upstreamOrigin}/v1`,
    env: [],
    headers: { "X-Acme-Tenant": "prod" },
    models: { "acme-1": { name: "Acme One" } },
  })
  await putCredential({ provider_id: "acme", kind: "api_key", source: "local_only", secret: "sk-acme-stored" })
}, 60_000)

afterAll(async () => {
  await drainOpenCodeSdkRuntime()
  disposeAgentConfig()
  setBackendOverride(undefined)
  upstream.closeAllConnections()
  brokerServer.closeAllConnections()
  await new Promise((resolve) => upstream.close(resolve))
  await new Promise((resolve) => brokerServer.close(resolve))
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
}, 60_000)

test("a custom provider with a stored key is one the engine runs, and the catalog says so", async () => {
  const engine = await openCodeEngineModels()
  expect(engine.filter((model) => model.providerID === "acme").map((model) => model.id)).toEqual(["acme-1"])

  const catalog = await opencodeProviderCatalog({
    env: { CLAXEDO_OPENCODE_CATALOG_CACHE: path.join(dataDir, "models-dev.json") },
    fetchImpl: async () => new Response(JSON.stringify({ other: { id: "other", name: "Other", env: [], models: { o: { id: "o", name: "O" } } } })),
    engineModels: openCodeEngineModels,
  })
  expect(catalog.all.find((provider) => provider.id === "acme")?.models["acme-1"]).toMatchObject({ connected: true })
  expect(catalog.connected).toContain("acme")
}, 60_000)

test("a turn on it reaches the endpoint through the broker, which alone puts the stored key on it", async () => {
  const runtime = openCodeSdkRuntime()
  const directory = mkdtempSync(path.join(dataDir, "work-"))
  const session = await runtime.sessions.create(WorkspaceScope.authorize({ workspaceID: "w", directory }), { title: "custom provider" })
  const adapter = new OpenCodeSdkHarnessAdapter({ runtime, workspaceID: "w", directory, reportOwnerFailure: () => {} })
  const turn = adapter.executeTurn(
    { workspaceId: "w", directory, sessionId: session.id, connectionId: "native:opencode", upstreamSessionId: session.id },
    {
      parts: [{ type: "text", text: "say hello" }],
      userMessageId: "msg_user_1",
      assistantMessageId: "msg_assistant_1",
      agent: "build",
      model: { providerID: "acme", modelID: "acme-1" },
    },
  )
  const events: { type: string }[] = []
  for await (const event of turn) events.push(event)

  expect(events.filter((event) => event.type === "error")).toEqual([])

  expect(upstreamRequests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer sk-acme-stored", tenant: "prod" })
}, 60_000)
