import assert from "node:assert/strict"
import { createServer } from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-endpoint-proof-"))
const received = []
const endpoint = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  received.push({ path: request.url, method: request.method, authorization: request.headers.authorization ?? null,
    body: Buffer.concat(chunks).toString() })
  response.writeHead(401, { "content-type": "application/json" })
  response.end(JSON.stringify({ code: "unauthenticated", message: "intentional broker feasibility rejection" }))
})
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve))
process.env.CURSOR_BACKEND_URL = `http://127.0.0.1:${endpoint.address().port}`
process.env.CURSOR_DATA_DIR = path.join(directory, "data")
process.env.CURSOR_AGENT_STORE_FILES_DIR = path.join(directory, "store")
const { Agent } = await import("@cursor/sdk")
let agent
let run
let failure
try {
  try {
    agent = await Agent.create({ model: { id: "auto" }, apiKey: "broker-probe-placeholder", local: { cwd: directory, settingSources: [], enableAgentRetries: false } })
    run = await agent.send("Reply with hello; do not use tools")
    const result = await run.wait()
    assert.equal(result.status, "error", "The local endpoint deliberately rejects authentication")
    failure = result.error?.message
  } catch (error) {
    failure = String(error)
  }
  assert.ok(received.length > 0, `No request reached CURSOR_BACKEND_URL: ${failure}`)
  assert.ok(received.some((request) => request.path === "/auth/exchange_user_api_key"))
  assert.ok(received.every((request) => request.authorization === "Bearer broker-probe-placeholder"))
  assert.ok(failure, "Expected the local authentication rejection")
  console.log(JSON.stringify({ ok: true, sdk: "1.0.24", endpointOverride: "CURSOR_BACKEND_URL", received, acceptance: "endpoint transport only; authentication deliberately rejected" }))
} finally {
  if (run?.status === "running") await run.cancel()
  agent?.close()
  endpoint.closeAllConnections()
  await new Promise((resolve) => endpoint.close(resolve))
  await fs.rm(directory, { recursive: true, force: true })
}
