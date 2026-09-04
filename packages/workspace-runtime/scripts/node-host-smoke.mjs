import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

assert.equal(typeof globalThis.Bun, "undefined")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-node-host-"))
const previousDirectory = process.cwd()
Object.assign(process.env, {
  HOME: root, XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCODE_TEST_HOME: root, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  WORKSPACE_RUNTIME_DIRECTORY: root,
})
process.chdir(root)
const { Hono } = await import("hono")
const { createWorkspaceHost } = await import("../dist/host.mjs")
const { createOpenCodeRuntime } = await import("../dist/opencode.mjs")
const { loopbackWorkspaceRuntimeExposure } = await import("../dist/exposure.mjs")
const runtime = createOpenCodeRuntime({ databasePath: path.join(root, "opencode.db") })
const host = createWorkspaceHost({
  opencodeRuntime: runtime,
  harness: { id: "opencode", access: "native" },
  storeRoot: path.join(root, "runtime-store"),
})
const app = new Hono()
host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
const request = (url, body) => app.request("http://localhost" + url, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
try {
  const id = "ses_embedded_node_smoke"
  const response = await request("/session?harness=opencode", {
    id, title: "Node host smoke",
    model: { providerID: "missing-provider", modelID: "missing-model" },
  })
  assert.equal(response.status, 201, await response.clone().text())
  assert.equal((await response.json()).id, id)
  const prompt = await request("/session/" + id + "/prompt_async?harness=opencode", {
    messageID: "msg_embedded_node_failure",
    parts: [{ type: "text", text: "Exercise a deliberate pre-provider failure." }],
    model: { providerID: "missing-provider", modelID: "missing-model" },
  })
  assert.equal(prompt.status, 204, await prompt.clone().text())
  let failed = false
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await request("/session/" + id)).json()
    if (state.lastTurn?.status === "failed") { failed = true; break }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(failed, true, "The failed turn must be recorded by the runtime")
  const snapshot = await (await request("/session/" + id + "/message?snapshot=1")).json()
  assert.ok(Array.isArray(snapshot.messages))
  assert.ok(Number.isSafeInteger(snapshot.maxEventOrdinal))
  assert.equal((await request("/api/session")).status, 404)
  console.log(JSON.stringify({ ok: true, node: process.versions.node, electron: process.versions.electron ?? null }))
} finally {
  host.dispose()
  await runtime.close()
  process.chdir(previousDirectory)
  fs.rmSync(root, { recursive: true, force: true })
}
