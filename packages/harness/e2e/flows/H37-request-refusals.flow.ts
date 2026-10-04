import assert from "node:assert/strict"
import { ApiError, ClaxedoApi } from "../harness/api"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"

export async function run() {
  const stack = await startStack({ label: "h37-refusals" })
  try {
    const api = new ClaxedoApi(stack.url)
    const first = await stack.daemon.makeWorkspace("h37-first")
    const before = (await readAcpRequests(stack.acp.scriptDir)).length
    const unknown = await api.session(first.directory, "ses_h37_missing").then(
      () => assert.fail("an unknown session was served"),
      (error: unknown) => error,
    )
    assert.ok(unknown instanceof ApiError, String(unknown))
    assert.equal(unknown.status, 404, unknown.body)
    assert.equal((JSON.parse(unknown.body) as { error?: { code?: string } }).error?.code, "session_not_found")
    assert.equal((await readAcpRequests(stack.acp.scriptDir)).length, before, "a refused request reached the ACP agent")
    assert.deepEqual(stack.scripted.requests, [], "a refused request reached the model server")
    assert.deepEqual(stack.egress.attempts, [])
    console.log("H37: a request for an unknown session was refused before any turn")
  } finally {
    await stack.close()
  }
}
