import assert from "node:assert/strict"
import { test } from "node:test"
import { acp } from "../dist/harness-factories/acp.mjs"
import { MemoryRuntimeStore } from "../dist/stores/memory.mjs"

test("built ACP factory validates patterns in an isolated worker without external assets", { timeout: 10000 }, async () => {
  const store = new MemoryRuntimeStore()
  let send
  let newId
  const factory = acp("acp-pattern-package", { connection: { kind: "process", command: "fixture" }, createTransport() {
    let alive = true
    return { kind: "stdio", metadata: {}, get alive() { return alive }, dispose() { alive = false }, stream: {
      readable: new ReadableStream({ start(controller) { send = (message) => controller.enqueue(message) } }),
      writable: new WritableStream({ write(message) {
        if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
        if (message.method === "session/new") {
          newId = message.id
          send({ jsonrpc: "2.0", id: "pattern-question", method: "elicitation/create", params: { requestId: newId, mode: "form", message: "Pattern", requestedSchema: { type: "object", properties: { answer: { type: "string", pattern: "(?<=a)b" } }, required: ["answer"] } } })
        }
        if (message.id === "pattern-question") {
          assert.deepEqual(message.result, { action: "accept", content: { answer: "ab" } })
          send({ jsonrpc: "2.0", id: newId, result: { sessionId: "upstream" } })
        }
      } }),
    } }
  } })
  const adapter = factory.create({ store })
  const start = { sessionId: "local", workspaceId: "workspace", directory: "/work", operationId: "op", connectionId: "connection:acp-pattern-package" }
  store.sessionStarts.begin(start)
  const creation = adapter.createSession("/work", undefined, "local", { start })
  try {
    for (let i = 0; i < 200 && !store.listQuestions("/work").length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    const id = store.listQuestions("/work")[0]?.id
    assert.ok(id)
    await assert.rejects(adapter.replySessionStartQuestion(start, id, [['{"answer":"no"}']]), { code: "invalid_answer" })
    assert.equal(store.listQuestions("/work").length, 1)
    await adapter.replySessionStartQuestion(start, id, [['{"answer":"ab"}']])
    assert.deepEqual(await creation, { id: "local" })
    assert.equal(store.listQuestions("/work").length, 0)
  } finally { adapter.dispose(); await creation.catch(() => {}) }
})
