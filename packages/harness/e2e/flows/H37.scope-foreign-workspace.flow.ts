import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { SCRIPTED_ACP_HARNESS } from "../harness/acp/connection"
import { readAcpRequests } from "../harness/acp/requests"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"

export async function run() {
  const stack = await startStack({ label: "h37-scope" })
  try {
    const api = new ClaxedoApi(stack.url)
    const first = await stack.daemon.makeWorkspace("h37-scope-first")
    const second = await stack.daemon.makeWorkspace("h37-scope-second")
    const session = await api.createSession(first.directory, { harness: SCRIPTED_ACP_HARNESS })
    const before = (await readAcpRequests(stack.acp.scriptDir)).filter((row) => row.method === "session/new").length
    const url = new URL("/session", stack.url)
    url.searchParams.set("directory", second.directory)
    url.searchParams.set("connectionId", SCRIPTED_ACP_HARNESS.id)
    const reply = await directTransport({ method: "POST", url: url.toString(), headers: { "content-type": "application/json" }, body: JSON.stringify({ id: session.id, harness: SCRIPTED_ACP_HARNESS }) })
    assert.equal((await readAcpRequests(stack.acp.scriptDir)).filter((row) => row.method === "session/new").length, before, "H-14: foreign-workspace create launched a second ACP session/new")
    assert.equal(reply.status, 409, `H-14: foreign-workspace create returned ${reply.status}`)
    assert.equal((JSON.parse(reply.body) as { error?: { code?: string } }).error?.code, "session_create_conflict", "H-14: foreign-workspace refusal is not typed")
    assert.equal((await api.session(first.directory, session.id)).id, session.id)
  } finally {
    await stack.close()
  }
}
