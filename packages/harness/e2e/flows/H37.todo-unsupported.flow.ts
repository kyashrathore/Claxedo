import assert from "node:assert/strict"
import { ApiError, ClaxedoApi } from "../harness/api"
import { startStack } from "../harness/stack"

export async function run() {
  const stack = await startStack({ label: "h37-todo" })
  try {
    const api = new ClaxedoApi(stack.url)
    const workspace = await stack.daemon.makeWorkspace("h37-todo")
    const pi = await api.createSession(workspace.directory, { harness: { id: "pi", access: "native" }, model: { providerId: "pi", modelId: "openai/gpt-4.1" } })
    const refusal = await api.todos(workspace.directory, pi.id).then(
      (todos) => assert.fail(`H-16: Pi todos read answered ${JSON.stringify(todos)} despite the absent capability`),
      (error: unknown) => error,
    )
    assert.ok(refusal instanceof ApiError, `H-16: Pi todos read failed outside the API: ${String(refusal)}`)
    assert.equal(refusal.status, 409, `H-16: Pi todos read returned ${refusal.status} and ${refusal.body} despite the absent capability`)
    assert.equal((JSON.parse(refusal.body) as { error?: { code?: string } }).error?.code, "unsupported_operation", "H-16: Pi todo refusal is untyped")
    assert.deepEqual(stack.scripted.requests, [])
  } finally {
    await stack.close()
  }
}
