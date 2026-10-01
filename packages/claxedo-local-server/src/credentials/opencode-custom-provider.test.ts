import { execFileSync } from "node:child_process"
/**
 * A custom OpenCode provider from its stored row to a turn's request: the real
 * registry, the real loopback broker, the embedded workspace runtime's own
 * engine and the served catalog, with only the vendor replaced by a recording
 * endpoint.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { EMBEDDED_RELAY_HOST_AUTH_HEADER } from "@claxedo/workspace-runtime/exposure"
import type { ControlPlaneServicesContract } from "@claxedo/server-core/authority/control-plane-contract"

const dataDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-custom-provider-engine-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = dataDir

const [
  { putCustomProvider, deleteCustomProvider },
  { putCredential, listCredentials },
  { createTestBackend, setBackendOverride },
  { configureAgentConfig, disposeAgentConfig },
  { agentConfigProviderRoutes },
  { ensureWorkspace },
  { configureEmbeddedWorkspaceRuntime, ensureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes, syncEmbeddedWorkspaceRuntimes },
  { createLocalCredentialBroker },
  { localControlPlaneCredentials },
  { ClaxedoDB },
] = await Promise.all([
  import("@claxedo/server-core/credentials/custom-provider"),
  import("@claxedo/server-core/credentials/registry"),
  import("@claxedo/server-core/credentials/backend-registry"),
  import("@claxedo/server-core/agent-config/index"),
  import("../agent-config/routes/provider-routes"),
  import("@claxedo/server-core/workspace/store/index"),
  import("../deployments/local/embedded-workspace-runtime"),
  import("./broker"),
  import("./machine-credentials"),
  import("@claxedo/server-core/platform/db/index"),
])

type Recorded = { path: string; authorization?: string; tenant?: string; googKey?: string }
const upstreamRequests: Recorded[] = []
let upstream: Server
let brokerServer: Server
let provider: Parameters<typeof putCustomProvider>[0]
let runtime: Awaited<ReturnType<typeof ensureEmbeddedWorkspaceRuntime>>
let directory: string
let sessionId: string
let holdProjection: { reached: () => void; released: Promise<void> } | undefined

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
}

beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    for await (const _ of request) void _
    const tenant = request.headers["x-title"]
    const googKey = request.headers["x-goog-api-key"]
    upstreamRequests.push({
      path: request.url ?? "",
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(typeof tenant === "string" ? { tenant } : {}),
      ...(typeof googKey === "string" ? { googKey } : {}),
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
  const broker = createLocalCredentialBroker({ machineOwnerUserId: () => "local", dataDir, brokerOrigin })
  handler = broker.handler
  configureAgentConfig({ projectAuth: async (input) => {
    const hold = holdProjection
    holdProjection = undefined
    if (hold) { hold.reached(); await hold.released }
    return await broker.projectAuth(input)
  } })
  configureEmbeddedWorkspaceRuntime({})

  setBackendOverride(createTestBackend())
  provider = {
    providerID: "acme",
    name: "Acme",
    baseURL: `${upstreamOrigin}/v1`,
    env: [],
    headers: { "X-Title": "prod" },
    credentialHeader: { name: "Authorization", scheme: "Bearer" },
    models: { "acme-1": { name: "Acme One" } },
  }
  putCustomProvider(provider)
  await putCredential({ owner: "local", provider_id: "acme", kind: "api_key", source: "local_only", secret: "sk-acme-stored" })
  directory = mkdtempSync(path.join(dataDir, "work-"))
  execFileSync("sh", ["-c", "unset GIT_INDEX_FILE; git init -q"], { cwd: directory })
  const workspace = await ensureWorkspace({ workspaceId: "ws_custom_provider", directory, kind: "local" })
  if (!workspace) throw new Error("Test workspace registration failed")
  directory = workspace.directory
  runtime = await ensureEmbeddedWorkspaceRuntime(workspace)
}, 60_000)

afterAll(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
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

async function openCodeEngineModels() {
  const response = await runtime.app.request(`http://runtime.test/api/wr/harness-providers?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  const entries = await response.json() as Array<{ connected: boolean; models: Array<{ providerID: string; id: string }> }>
  return entries.filter((entry) => entry.connected).flatMap((entry) => entry.models)
}

test("a share holder cannot claim the engine through a draft preview before its owner", async () => {
  const shareHolder = JSON.stringify({
    principal_kind: "user", actor_id: "actor_viewer", user_id: "user_viewer", actor_kind: "human",
    actor_public_id: "usr_viewer", actor_name: "Viewer", workspace_id: "ws_custom_provider", org_id: "org_1",
    role: "viewer", session_id: "ses_shared",
  })
  const response = await runtime.app.request(
    `http://runtime.test/api/wr/harness-config-options?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`,
    { headers: { [EMBEDDED_RELAY_HOST_AUTH_HEADER]: shareHolder } },
  )
  expect(response.status, await response.clone().text()).toBe(403)
  expect((await openCodeEngineModels()).some((model) => model.providerID === "acme")).toBe(true)
}, 60_000)

test("the public draft preview decodes the provider-qualified selected model", async () => {
  const response = await runtime.app.request(`/api/wr/harness-config-options?nativeHarness=opencode&model=acme%2Facme-1&directory=${encodeURIComponent(directory)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({ resolvedModel: { id: "acme/acme-1", name: "Acme One" } })
}, 60_000)

test("a custom provider with a stored key is one the engine runs, and the catalog says so", async () => {
  const engine = await openCodeEngineModels()
  expect(engine.filter((model) => model.providerID === "acme").map((model) => model.id)).toEqual(["acme-1"])

  const app = agentConfigProviderRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
  const response = await app.request(`/providers?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  const catalog = await response.json() as { all: Array<{ id: string; models: Record<string, { connected: boolean }> }>; connected: string[] }

  expect(catalog.all.find((provider) => provider.id === "acme")?.models["acme-1"]).toMatchObject({ connected: true })
  expect(catalog.connected).toContain("acme")
  expect(catalog.all.find((provider) => provider.id === "acme")).toMatchObject({ name: "Acme", source: "custom", options: { baseURL: provider.baseURL } })
  expect(catalog.all.some((provider) => provider.id === "anthropic")).toBe(true)
}, 60_000)

test("with no workspace named, Settings and onboarding list the vendors and declared providers, connected by stored accounts", async () => {
  const app = agentConfigProviderRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
  await putCredential({ owner: "local", provider_id: "groq", kind: "api_key", source: "local_only", secret: "sk-groq-onboarding" })
  const response = await app.request("/providers?nativeHarness=opencode")
  expect(response.status, await response.clone().text()).toBe(200)
  const catalog = await response.json() as { all: Array<{ id: string; name: string; source: string; models: Record<string, { connected: boolean }> }>; connected: string[] }
  const row = (id: string) => catalog.all.find((provider) => provider.id === id)
  expect(row("groq")).toMatchObject({ name: "Groq", source: "api", models: {} })
  expect(row("anthropic")).toMatchObject({ name: "Anthropic", source: "config", models: {} })
  expect(row("acme")).toMatchObject({ name: "Acme", source: "custom", models: { "acme-1": { connected: true } } })
  expect(catalog.connected).toEqual(expect.arrayContaining(["groq", "acme"]))
  expect(catalog.connected).not.toContain("anthropic")
}, 60_000)

test("a turn on it reaches the endpoint through the broker, which alone puts the stored key on it", async () => {
  const created = await runtime.app.request(`http://runtime.test/session?directory=${encodeURIComponent(directory)}&nativeHarness=opencode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "custom provider", model: { providerID: "acme", modelID: "acme-1" } }),
  })
  expect(created.status, await created.clone().text()).toBe(201)
  const session = await created.json() as { id: string }
  sessionId = session.id
  const prompted = await runtime.app.request(`http://runtime.test/session/${session.id}/message?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageID: "msg_user_1", parts: [{ type: "text", text: "say hello" }], model: { providerID: "acme", modelID: "acme-1" } }),
  })
  expect(prompted.status, await prompted.clone().text()).toBe(200)
  const reply = await prompted.json() as { info: { role: string; error?: unknown } }
  expect(reply.info).toMatchObject({ role: "assistant" })
  expect(reply.info.error).toBeUndefined()

  expect(upstreamRequests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer sk-acme-stored", tenant: "prod" })
}, 60_000)

test("an environment-backed provider's key is resolved by the credential producer and reaches a real turn through the broker", async () => {
  const name = "CLAXEDO_CUSTOM_PROVIDER_ENVCO_API_KEY"
  const previous = process.env[name]
  process.env[name] = "sk-envco-from-env"
  try {
    const app = agentConfigProviderRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" },
      services: { credentials: localControlPlaneCredentials() } as unknown as ControlPlaneServicesContract })
    const saved = await app.request("/providers/custom?nativeHarness=opencode", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerID: "envco", name: "Env Co", baseURL: provider.baseURL, env: [name], models: { "envco-1": { name: "Env One" } } }),
    })
    expect(saved.status, await saved.clone().text()).toBe(200)
    const reply = await customTurn("envco", "envco-1", "msg_env")
    expect(reply.info.error).toBeUndefined()
    expect(upstreamRequests.at(-1)).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer sk-envco-from-env" })
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}, 60_000)

test("a key header saved through the Settings route carries the stored key there, through the broker, on a real turn", async () => {
  const app = agentConfigProviderRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
  const saved = await app.request("/providers/custom?nativeHarness=opencode", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerID: "googco", name: "Goog Co", baseURL: provider.baseURL, env: [], headers: { "X-Title": "goog" },
      credentialHeader: { name: "X-Goog-Api-Key" }, models: { "goog-1": { name: "Goog One" } } }),
  })
  expect(saved.status, await saved.clone().text()).toBe(200)
  expect(await saved.json()).toMatchObject({ credentialHeader: { name: "X-Goog-Api-Key" } })
  await localControlPlaneCredentials().putCredential({ owner: "local", provider_id: "googco", kind: "api_key", source: "managed", secret: "sk-goog-stored" })
  const catalog = await (await app.request(`/providers?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`)).json() as
    { all: Array<{ id: string; source: string; options?: { headers?: Record<string, string> } }>; connected: string[] }
  expect(catalog.all.find((row) => row.id === "googco")).toMatchObject({ source: "custom", options: { headers: { "X-Title": "goog" } } })
  expect(catalog.connected).toContain("googco")
  expect((await customTurn("googco", "goog-1", "msg_goog")).info.error).toBeUndefined()
  expect(upstreamRequests.at(-1)).toMatchObject({ path: "/v1/chat/completions", googKey: "sk-goog-stored", tenant: "goog" })
  expect(upstreamRequests.at(-1)?.authorization).toBeUndefined()
}, 60_000)

test("Settings keeps disconnect and reconnect rows for accounts the engine refuses", async () => {
  const credentials = localControlPlaneCredentials()
  const openai = await credentials.putCredential({ owner: "local", provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-openai-stored" })
  await credentials.updateCredentialStatus(openai.id, "revoked", "revoked by the operator")
  const envco = listCredentials().find((credential) => credential.provider_id === "envco")
  if (!envco) throw new Error("the env-backed provider's credential was not stored")
  await credentials.updateCredentialStatus(envco.id, "revoked", "revoked by the operator")

  const app = agentConfigProviderRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
  const response = await app.request(`/providers?nativeHarness=opencode&directory=${encodeURIComponent(directory)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  const catalog = await response.json() as { all: Array<{ id: string; source: string; models: Record<string, { connected: boolean }> }>; connected: string[] }
  const row = (id: string) => catalog.all.find((provider) => provider.id === id)
  expect(row("openai")).toMatchObject({ source: "api" })
  expect(row("envco")).toMatchObject({ source: "custom", models: { "envco-1": { connected: false } } })
  expect(row("acme")).toMatchObject({ source: "custom", models: { "acme-1": { connected: true } } })
  expect(catalog.connected).toContain("acme")
  expect(catalog.connected).not.toContain("openai")
  expect(catalog.connected).not.toContain("envco")
}, 60_000)

test("a removal that lands while an earlier refresh is applying is applied before it is acknowledged", async () => {
  putCustomProvider({ ...provider, providerID: "racer", models: { "racer-1": { name: "Racer" } } })
  await syncEmbeddedWorkspaceRuntimes()
  expect((await openCodeEngineModels()).some((model) => model.providerID === "racer")).toBe(true)

  let reached!: () => void
  let release!: () => void
  const captured = new Promise<void>((resolve) => { reached = resolve })
  holdProjection = { reached, released: new Promise<void>((resolve) => { release = resolve }) }
  const refresh = syncEmbeddedWorkspaceRuntimes()
  await captured
  const app = agentConfigProviderRoutes({ authConfig: { enabled: false, mode: "local-only", reason: "test" } })
  const removal = app.request("/providers/custom/racer?nativeHarness=opencode", { method: "DELETE" })
  release()
  await refresh
  const removed = await removal
  expect(removed.status, await removed.clone().text()).toBe(200)
  expect((await openCodeEngineModels()).some((model) => model.providerID === "racer")).toBe(false)
}, 60_000)

test("saved definitions refresh and remove from the same workspace engine without crossing orgs", async () => {
  putCustomProvider({ ...provider, providerID: "other-org", models: { private: { name: "Private" } } }, "another-org")
  putCustomProvider({ ...provider, headers: { "X-Title": "refreshed" }, models: { "acme-2": { name: "Acme Two" } } })
  await syncEmbeddedWorkspaceRuntimes()
  const refreshed = await openCodeEngineModels()
  expect(refreshed.filter((model) => model.providerID === "acme").map((model) => model.id)).toEqual(["acme-2"])
  expect(refreshed.some((model) => model.providerID === "other-org")).toBe(false)
  const reply = await customTurn("acme", "acme-2", "msg_refreshed")
  expect(reply.info.error).toBeUndefined()
  expect(upstreamRequests.at(-1)).toMatchObject({ authorization: "Bearer sk-acme-stored", tenant: "refreshed" })
  deleteCustomProvider("acme")
  await syncEmbeddedWorkspaceRuntimes()
  expect((await openCodeEngineModels()).some((model) => model.providerID === "acme")).toBe(false)
  const requests = upstreamRequests.length
  expect((await customTurn("acme", "acme-2", "msg_removed")).info.error).toBeDefined()
  expect(upstreamRequests).toHaveLength(requests)
}, 60_000)

async function customTurn(providerID: string, modelID: string, messageID: string) {
  const response = await runtime.app.request(`http://runtime.test/session/${sessionId}/message?directory=${encodeURIComponent(directory)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageID, parts: [{ type: "text", text: "say hello" }], model: { providerID, modelID } }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json() as { info: { error?: unknown } }
}
