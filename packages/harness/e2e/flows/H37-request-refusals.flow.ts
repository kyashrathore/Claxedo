import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"
import { deliveredUnsupportedOperation } from "../harness/request-refusal-fault"

type ErrorBody = { error?: { code?: string; message?: string } }

export async function run() {
  const stack = await startStack({ label: "h37-refusals" })
  try {
    const api = new ClaxedoApi(stack.url)
    const first = await stack.daemon.makeWorkspace("h37-first")
    const request = async (method: string, route: string, directory?: string, body?: unknown) => {
      const delivered = deliveredUnsupportedOperation(route, body)
      const url = new URL(delivered.route, stack.url)
      if (directory) url.searchParams.set("directory", directory)
      const reply = await directTransport({ method, url: url.toString(), headers: delivered.body === undefined ? undefined : { "content-type": "application/json" }, body: delivered.body === undefined ? undefined : JSON.stringify(delivered.body) })
      return { status: reply.status, body: JSON.parse(reply.body) as ErrorBody }
    }
    const before = (await readAcpRequests(stack.acp.scriptDir)).length
    const unknown = await request("GET", "/session/ses_h37_missing", first.directory)
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body))
    assert.equal(unknown.body.error?.code, "session_not_found")

    const pi = await api.createSession(first.directory, { harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
    const command = await request("POST", `/session/${encodeURIComponent(pi.id)}/command`, first.directory, { command: "unsupported" })
    assert.equal(command.status, 501, JSON.stringify(command.body))
    assert.equal(command.body.error?.code, "unsupported_operation")
    assert.equal((await readAcpRequests(stack.acp.scriptDir)).length, before, "a refused request reached the ACP agent")
    assert.deepEqual(stack.scripted.requests, [], "a refused request reached the model server")
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H37: unknown and unsupported command requests were refused before any turn")
  } finally {
    await stack.close()
  }
}
