import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { fileSystemCollectionSource } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { createLocalAgentPluginsComposition } from "@claxedo/local-server/agent-plugins/local-composition"
import { createDefaultLocalControlPlaneServices, createSelfHostedApp } from "./app"
import { getEmbeddedAuth, resetEmbeddedAuthForTests } from "./embedded-auth"

let root: string
let services: ReturnType<typeof createDefaultLocalControlPlaneServices>
let composed: ReturnType<typeof createSelfHostedApp>
let plugins: ReturnType<typeof createLocalAgentPluginsComposition>
let operator: { id: string; headers: { authorization: string } }
let member: typeof operator

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-auth-"))
  vi.stubEnv("CLAXEDO_DATA_DIR", root)
  vi.stubEnv("CLAXEDO_STATE_DIR", path.join(root, "state"))
  vi.stubEnv("CLAXEDO_EMBEDDED_AUTH", "1")
  vi.stubEnv("CLAXEDO_DEPLOYMENT_MODE", "local")
  vi.stubEnv("CLAXEDO_CHANNELS_ENABLED", "0")
  vi.stubEnv("BETTER_AUTH_URL", "http://selfhost.test")
  resetEmbeddedAuthForTests()
  const embedded = getEmbeddedAuth()
  await embedded.ready
  async function signup(email: string) {
    const response = await embedded.handler(new Request("http://selfhost.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "synthetic-test-password", name: email }),
    }))
    expect(response.status).toBe(200)
    const token = response.headers.get("set-auth-token")
    expect(token).toBeTruthy()
    const body = await response.json() as { user: { id: string } }
    return { id: body.user.id, headers: { authorization: `Bearer ${token}` } }
  }
  operator = await signup("operator@example.test")
  member = await signup("member@example.test")
  vi.stubEnv("CLAXEDO_OPERATOR_SUBJECTS", operator.id)
  services = createDefaultLocalControlPlaneServices()
  const collection = path.join(root, "collection")
  await fs.mkdir(path.join(collection, "synthetic"), { recursive: true })
  await fs.writeFile(path.join(collection, "synthetic", "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "synthetic", version: "1.0.0",
  }))
  await fs.writeFile(path.join(collection, "synthetic", "README.md"), "Synthetic nonexecuting plugin")
  plugins = createLocalAgentPluginsComposition(process.env, { sources: {
    listAuthorizedSources: async () => [await fileSystemCollectionSource({
      id: "synthetic", kind: "claxedo", label: "Synthetic", revision: "test",
    }, collection)],
  } })
  await plugins.ready
  composed = createSelfHostedApp(services, { routeContributions: plugins.routeContributions })
})

afterAll(async () => {
  await composed?.dispose()
  services?.close()
  ClaxedoDB.close()
  closeAuthorityDatabases()
  resetEmbeddedAuthForTests()
  vi.unstubAllEnvs()
  if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const routes = [
  ["GET", ""],
  ["GET", "/sources"],
  ["POST", "/sources"],
  ["POST", "/activation"],
  ["GET", "/machine-installed"],
  ["GET", "/signed-runtime"],
  ["PUT", "/signed-runtime"],
] as const

test.each(routes)("%s plugins%s denies anonymous and unrelated signed users before parsing", async (method, suffix) => {
  for (const [headers, status] of [[{}, 401], [member.headers, 403], [{ authorization: "Bearer invalid" }, 401]] as const) {
    const response = await composed.app.request(`http://selfhost.test/api/claxedo/plugins${suffix}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(method !== "GET" ? { body: "invalid-json" } : {}),
    })
    expect(response.status).toBe(status)
  }
  expect(plugins.signedRuntime.state()).toEqual({ active: false })
})

test("the configured operator can read, materialize and withdraw a nonexecuting runtime", async () => {
  const catalog = await composed.app.request("http://selfhost.test/api/claxedo/plugins", { headers: operator.headers })
  expect(catalog.status).toBe(200)
  const { revision, candidates } = await catalog.json() as { revision: number; candidates: Array<{ pluginInstanceId: string; builtIn?: boolean }> }
  const candidate = candidates.find((item) => !item.builtIn)!
  expect(candidate).toBeDefined()
  const activate = await composed.app.request("http://selfhost.test/api/claxedo/plugins/activation", {
    method: "POST", headers: { ...operator.headers, "content-type": "application/json" },
    body: JSON.stringify({ pluginInstanceId: candidate.pluginInstanceId, harnessIds: ["claude"], choice: true, expectedRevision: revision }),
  })
  expect(activate.status).toBe(200)
  expect(await activate.json()).toMatchObject({ revision: revision + 1, reconciliation: { state: "applied" } })
  const request = {
    version: 1,
    execution: { mode: "default" },
    identity: { mode: "signed", userId: operator.id, projectId: "synthetic-project" },
    revision: 1,
    artifacts: [], selections: [], mcpServers: [], secrets: [],
  }
  const apply = await composed.app.request("http://selfhost.test/api/claxedo/plugins/signed-runtime", {
    method: "PUT",
    headers: { ...operator.headers, "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  expect(apply.status).toBe(200)
  expect(plugins.signedRuntime.state()).toMatchObject({ active: true, userId: operator.id, revision: 1 })
  const denied = await composed.app.request("http://selfhost.test/api/claxedo/plugins/signed-runtime", {
    method: "PUT", headers: member.headers, body: "null",
  })
  expect(denied.status).toBe(403)
  expect(plugins.signedRuntime.state()).toMatchObject({ active: true, revision: 1 })
  const clear = await composed.app.request("http://selfhost.test/api/claxedo/plugins/signed-runtime", {
    method: "PUT", headers: operator.headers, body: "null",
  })
  expect(clear.status).toBe(200)
  expect(plugins.signedRuntime.state()).toEqual({ active: false })
})

test("machine enrollment rejects anonymous and unrelated signed users before availability or parsing", async () => {
  for (const [headers, status] of [[{}, 401], [member.headers, 403]] as const) {
    const response = await composed.app.request("http://selfhost.test/api/claxedo/remote-access/enable", {
      method: "POST", headers, body: "invalid-json",
    })
    expect(response.status).toBe(status)
  }
})

test("removing the configured operator takes effect on recomposition and fails closed", async () => {
  vi.stubEnv("CLAXEDO_OPERATOR_SUBJECTS", "")
  const restarted = createSelfHostedApp(services, { routeContributions: plugins.routeContributions })
  try {
    const response = await restarted.app.request("http://selfhost.test/api/claxedo/plugins/signed-runtime", {
      headers: operator.headers,
    })
    expect(response.status).toBe(403)
  } finally {
    await restarted.dispose()
  }
})
