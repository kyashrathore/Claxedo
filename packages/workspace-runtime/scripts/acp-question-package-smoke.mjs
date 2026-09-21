import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"

// Exercise the published runtime and SDK together: source imports conceal a
// duplicated contract class in a bundle and make instanceof checks pass.
const directory = await mkdtemp(join(tmpdir(), "acp-question-package-"))
process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
process.env.WORKSPACE_RUNTIME_WORKSPACE_ID = "acp-package-test"
const { createWorkspaceHost } = await import("../dist/host.mjs")
const { loopbackWorkspaceRuntimeExposure } = await import("../dist/exposure.mjs")
const host = createWorkspaceHost({ storeRoot: join(directory, "state") })
const app = new Hono()
host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
const request = (route, body) => app.request(`http://localhost${route}`, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
try {
  await host.apply({ version: 4, mcp: {}, auth: {}, connections: [{
    connectionId: "package-agent", providerKey: "acp", configRevision: 1, enabled: true,
    config: { label: "Package fixture", modelSelection: { status: "unsupported" }, connection: {
      kind: "process", command: process.execPath,
      args: [fileURLToPath(new URL("../src/workspace/fixtures/acp-initialize-question-peer.mjs", import.meta.url))],
      supportsMcpServers: false,
    } },
  }], defaultHarness: { kind: "connection", connectionId: "package-agent" } })
  const creating = request("/session", { id: "package-session", title: "Explicit package test" })
  let question
  for (let attempt = 0; attempt < 100; attempt++) {
    question = (await (await request("/question?sessionId=package-session")).json())[0]
    if (question) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(question, "The real ACP initialize request must reach the ordinary question route")
  for (const answer of ["{", JSON.stringify({ label: 42 })]) {
    const rejected = await request(`/question/${question.id}/reply`, { answers: [[answer]] })
    assert.equal(rejected.status, 400, await rejected.clone().text())
    assert.equal((await rejected.json()).error.code, "elicitation_invalid_answer")
    const pending = await (await request("/question?sessionId=package-session")).json()
    assert.equal(pending[0].id, question.id, "Validation must retain the original pending question")
  }
  const accepted = await request(`/question/${question.id}/reply`, { answers: [[JSON.stringify({ label: "Package" })]] })
  assert.equal(accepted.status, 200, await accepted.clone().text())
  assert.equal((await creating).status, 201)
  assert.deepEqual(await (await request("/question?sessionId=package-session")).json(), [])
  console.log("Published ACP question validation passed: malformed JSON, schema rejection, corrected reply")
} finally {
  await host.dispose()
  await rm(directory, { recursive: true, force: true })
}
