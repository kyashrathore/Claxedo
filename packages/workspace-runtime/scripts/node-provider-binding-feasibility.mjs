/**
 * Does a Claxedo provider binding route one of the engine's own providers?
 *
 * The question is only where the request goes and what it carries, so the local
 * endpoint records the first request and the run ends there: completing a turn
 * would mean emulating the vendor's wire format, which proves nothing more
 * about the binding.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-binding-proof-"))
const previousDirectory = process.cwd()
Object.assign(process.env, {
  OPENCODE_TEST_HOME: root, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"), WORKSPACE_RUNTIME_DIRECTORY: root,
})
process.chdir(root)
const requests = []
const arrived = Promise.withResolvers()
const provider = createServer(async (request, response) => {
  for await (const chunk of request) void chunk
  requests.push({ path: request.url, authorization: request.headers.authorization ?? null })
  arrived.resolve()
  response.writeHead(401, { "content-type": "application/json" })
  response.end(JSON.stringify({ error: { message: "intentional binding feasibility rejection" } }))
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
const binding = `http://127.0.0.1:${provider.address().port}/bindings/proof/v1`
const { Hono } = await import("hono")
const { createWorkspaceHost } = await import("../dist/host.mjs")
const { createOpenCodeRuntime } = await import("../dist/opencode.mjs")
const { loopbackWorkspaceRuntimeExposure } = await import("../dist/exposure.mjs")
const runtime = createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db"), configContent: "{}" })
const host = createWorkspaceHost({ opencodeRuntime: runtime, harness: { id: "opencode", access: "native" }, storeRoot: path.join(root, "store") })
const app = new Hono()
host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
const request = (url, body) => app.request(`http://localhost${url}`, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
try {
  await runtime.host.client()
  const models = await runtime.catalog.models({ directory: root })
  // Any provider the engine defines itself proves the mechanism; the accounts
  // Claxedo actually binds are built-ins of the same kind.
  const model = models[0]
  assert.ok(model, "the engine listed no model to bind")
  await runtime.bindProviders({ [model.providerID]: { baseURL: binding, apiKey: "broker-placeholder" } })
  const id = "ses_binding_feasibility"
  const created = await request("/session?nativeHarness=opencode", { id, title: "Binding proof", model: { providerID: model.providerID, modelID: model.id } })
  assert.equal(created.status, 201, await created.clone().text())
  const prompted = await request(`/session/${id}/prompt_async?nativeHarness=opencode`, {
    messageID: "msg_binding_feasibility", parts: [{ type: "text", text: "Say hello without tools" }],
    model: { providerID: model.providerID, modelID: model.id },
  })
  assert.equal(prompted.status, 204, await prompted.clone().text())
  await Promise.race([
    arrived.promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no request reached the binding")), 45_000)),
  ])
  assert.ok(requests.every((received) => received.authorization === "Bearer broker-placeholder"), JSON.stringify(requests))
  console.log(JSON.stringify({
    ok: true, provider: model.providerID, model: model.id, requests, node: process.versions.node, applied: "runtime.bindProviders",
    acceptance: "endpoint and placeholder routing only; the endpoint deliberately rejects the request",
  }))
} finally {
  host.dispose()
  await runtime.close()
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  process.chdir(previousDirectory)
  fs.rmSync(root, { recursive: true, force: true })
}
