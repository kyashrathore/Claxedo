import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"

type ErrorBody = { error?: { code?: string; message?: string } }

export async function run() {
  const stack = await startStack({ label: "h37-refusals" })
  try {
    const api = new ClaxedoApi(stack.url)
    const first = await stack.daemon.makeWorkspace("h37-first")
    const second = await stack.daemon.makeWorkspace("h37-second")
    const request = async (method: string, route: string, directory?: string, body?: unknown) => {
      const url = new URL(route, stack.url)
      if (directory) url.searchParams.set("directory", directory)
      const reply = await directTransport({ method, url: url.toString(), headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
      let parsed: ErrorBody
      try { parsed = JSON.parse(reply.body) as ErrorBody } catch { parsed = { error: { message: reply.body } } }
      return { status: reply.status, body: parsed }
    }
    const before = (await readAcpRequests(stack.acp.scriptDir)).length
    const unknown = await request("GET", "/session/ses_h37_missing", first.directory)
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body))
    assert.equal(unknown.body.error?.code, "session_not_found")

    const noDirectory = await request("POST", "/session?connectionId=scripted-acp", undefined, { harness: SCRIPTED_ACP_HARNESS })
    assert.equal(noDirectory.status, 404, JSON.stringify(noDirectory.body))
    assert.equal(noDirectory.body.error?.message, "404 Not Found")

    const session = await api.createSession(first.directory, { harness: SCRIPTED_ACP_HARNESS, title: "H37 scope" })
    const foreign = await request("POST", "/session?connectionId=scripted-acp", second.directory, { id: session.id, harness: SCRIPTED_ACP_HARNESS })
    assert.equal(foreign.status, 409, JSON.stringify(foreign.body))
    assert.equal(foreign.body.error?.code, "session_create_conflict")
    assert.equal((await api.session(first.directory, session.id)).id, session.id)

    const pi = await api.createSession(first.directory, { harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
    const todos = await request("GET", `/session/${encodeURIComponent(pi.id)}/todo`, first.directory)
    assert.equal(todos.status, 501, JSON.stringify(todos.body))
    assert.equal(todos.body.error?.code, "unsupported_operation")
    assert.equal((await readAcpRequests(stack.acp.scriptDir)).length, before + 1, "a refused request reached the ACP agent")
    assert.deepEqual(stack.scripted.requests, [], "a refused request reached the model server")
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H37: unknown, directoryless, foreign scope and unsupported todo requests were refused before any turn")
  } finally {
    await stack.close()
  }
}
