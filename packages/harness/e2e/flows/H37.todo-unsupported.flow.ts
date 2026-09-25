import assert from "node:assert/strict"
import { ClaxedoApi } from "../harness/api"
import { startStack } from "../harness/stack"
import { directTransport } from "../harness/transport"

export async function run() {
  const stack = await startStack({ label: "h37-todo" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h37-todo")
    const pi = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
    const url = new URL(`/session/${encodeURIComponent(pi.id)}/todo`, stack.url)
    url.searchParams.set("directory", workspace.directory)
    const reply = await directTransport({ method: "GET", url: url.toString() })
    assert.equal(reply.status, 409, `H-16: Pi todo route returned ${reply.status} and ${reply.body} despite the absent capability`)
    assert.equal((JSON.parse(reply.body) as { error?: { code?: string } }).error?.code, "unsupported_operation", "H-16: Pi todo refusal is untyped")
    assert.deepEqual(stack.scripted.requests, [])
  } finally {
    await stack.close()
  }
}
