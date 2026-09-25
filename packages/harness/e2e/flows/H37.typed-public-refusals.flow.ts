import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"

export async function run() {
  const stack = await startStack({ label: "h37-typed" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h37-typed")
    const before = (await readAcpRequests(stack.acp.scriptDir)).length
    const unknown = new URL("/session/ses_h37_missing/message", stack.url)
    unknown.searchParams.set("directory", workspace.directory)
    const message = await directTransport({ method: "POST", url: unknown.toString(), headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "missing" }] }) })
    const create = await directTransport({ method: "POST", url: `${stack.url}/session?connectionId=scripted-acp`, headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: SCRIPTED_ACP_HARNESS }) })
    assert.equal((await readAcpRequests(stack.acp.scriptDir)).length, before, "H-15: refused operation reached ACP")
    assert.deepEqual(await api.sessions(workspace.directory), [])
    assert.equal(message.status, 404, `H-15: unknown-session message returned ${message.status}; directoryless create returned ${create.status}`)
    assert.equal((JSON.parse(message.body) as { error?: { code?: string } }).error?.code, "session_not_found", "H-15: unknown-session message refusal is untyped")
    assert.equal(create.status, 400, `H-15: directoryless create returned ${create.status}`)
    assert.equal((JSON.parse(create.body) as { error?: { code?: string } }).error?.code, "invalid_execution_binding", "H-15: directoryless create refusal is untyped")
  } finally {
    await stack.close()
  }
}
