import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer } from "node:http"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-provider-proof-"))
const previousDirectory = process.cwd()
Object.assign(process.env, {
  OPENCODE_TEST_HOME: root, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"), WORKSPACE_RUNTIME_DIRECTORY: root,
})
process.chdir(root)
const requests = []
const provider = createServer(async (request, response) => {
  const body = []
  for await (const chunk of request) body.push(chunk)
  requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(body).toString()) })
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const chunk of [
    { choices: [{ index: 0, delta: { role: "assistant", content: "Provider endpoint verified" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  ]) response.write(`data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", created: 1, model: "proof", ...chunk })}\n\n`)
  response.end("data: [DONE]\n\n")
})
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
const { Hono } = await import("hono")
const { createWorkspaceHost } = await import("../dist/host.mjs")
const { createOpenCodeRuntime } = await import("../dist/opencode.mjs")
const { loopbackWorkspaceRuntimeExposure } = await import("../dist/exposure.mjs")
const runtime = createOpenCodeRuntime({
  databasePath: path.join(root, "opencode.db"),
  configContent: JSON.stringify({
    model: "proof/proof", small_model: "proof/proof", enabled_providers: ["proof"],
    provider: { proof: { npm: "@ai-sdk/openai-compatible", name: "Proof", options: {
      baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "broker-placeholder",
    }, models: { proof: { name: "Proof", limit: { context: 32000, output: 1024 } } } } },
  }),
})
const host = createWorkspaceHost({ opencodeRuntime: runtime, harness: { id: "opencode", access: "native" }, storeRoot: path.join(root, "store") })
const app = new Hono()
host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
const request = (url, body) => app.request(`http://localhost${url}`, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
try {
  const id = "ses_provider_feasibility"
  const created = await request("/session?nativeHarness=opencode", { id, title: "Provider proof", model: { providerID: "proof", modelID: "proof" } })
  assert.equal(created.status, 201, await created.clone().text())
  const prompted = await request(`/session/${id}/prompt_async?nativeHarness=opencode`, {
    messageID: "msg_provider_feasibility", parts: [{ type: "text", text: "Say hello without tools" }], model: { providerID: "proof", modelID: "proof" },
  })
  assert.equal(prompted.status, 204, await prompted.clone().text())
  const deadline = Date.now() + 30_000
  let snapshot
  while (Date.now() < deadline) {
    snapshot = await (await request(`/session/${id}/message?snapshot=1`)).json()
    if (JSON.stringify(snapshot).includes("Provider endpoint verified")) break
    const state = await (await request(`/session/${id}`)).json()
    assert.notEqual(state.lastTurn?.status, "failed", JSON.stringify(state.lastTurn))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(JSON.stringify(snapshot).includes("Provider endpoint verified"), JSON.stringify(snapshot))
  assert.ok(requests.length > 0)
  for (const received of requests) {
    assert.equal(received.path, "/v1/chat/completions")
    assert.equal(received.authorization, "Bearer broker-placeholder")
    assert.equal(received.body.model, "proof")
  }
  console.log(JSON.stringify({ ok: true, requests: requests.length, node: process.versions.node, provider: "openai-compatible" }))
} finally {
  host.dispose()
  await runtime.close()
  provider.closeAllConnections()
  await new Promise((resolve) => provider.close(resolve))
  process.chdir(previousDirectory)
  fs.rmSync(root, { recursive: true, force: true })
}
