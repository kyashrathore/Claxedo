import { expect, test } from "bun:test"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { AcpHarnessAdapter, type ACPTransport } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"

function fixture(store = new MemoryRuntimeStore()) {
  const responses = new Map<string | number | null, AnyMessage>()
  let send!: (message: AnyMessage) => void
  let promptId: string | number | null
  let sessions = 0
  const adapter = new AcpHarnessAdapter({ harness: "elicitation-agent", connection: { kind: "process", command: "peer" }, store,
    createTransport() {
      const readable = new ReadableStream<AnyMessage>({ start(controller) { send = (message) => controller.enqueue(message) } })
      const writable = new WritableStream<AnyMessage>({ write(message) {
        if (!("method" in message)) { responses.set(message.id, message); return }
        if (!("id" in message)) {
          if (message.method === "session/cancel" && promptId != null) send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } })
          return
        }
        const result = message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, subagents: {} } } }
          : message.method === "session/new" ? { sessionId: ++sessions === 1 ? "remote" : "sibling" } : {}
        if (message.method === "session/prompt") { promptId = message.id; return }
        send({ jsonrpc: "2.0", id: message.id, result })
      } })
      const transport: ACPTransport = { kind: "stdio", stream: { readable, writable }, metadata: {}, alive: true, dispose() { this.alive = false } }
      return transport
    },
  })
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(predicate()).toBe(true)
  }
  const elicit = (id: string, scope: Record<string, unknown>, mode: "form" | "url" = "form") => send({ jsonrpc: "2.0", id, method: "elicitation/create", params: {
    ...scope, mode, message: "Please choose", ...(mode === "form"
      ? { requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
      : { elicitationId: id, url: "https://example.com/connect" }),
  } })
  return { store, adapter, responses, wait, elicit,
    spawn: (parent: string, child: string) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: parent, update: { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: "Child", task: "Help", capabilities: {} } } }),
    promptId: () => promptId,
    finish: () => send({ jsonrpc: "2.0", id: promptId!, result: { stopReason: "end_turn" } }) }
}

test("real ACP JSON-RPC elicitation persists a form and returns accepted content", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession("/repo", undefined, "local")
    f.elicit("question-one", { sessionId: "remote" })
    await f.wait(() => f.store.listQuestions("/repo").length === 1)
    const question = f.store.listQuestions("/repo")[0]!
    await f.adapter.replyQuestion({ ...executionBinding("local", "/repo"), upstreamSessionId: "remote" }, question.id, [[JSON.stringify({ name: "Alice" })]])
    await f.wait(() => f.responses.has("question-one"))
    expect(f.responses.get("question-one")).toMatchObject({ result: { action: "accept", content: { name: "Alice" } } })
    expect(f.store.listQuestions("/repo")).toEqual([])
  } finally { f.adapter.dispose() }
})

test("request-scoped elicitation uses an actual outstanding prompt ID and rejects unknown IDs", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession("/repo", undefined, "local")
    f.elicit("unowned", { requestId: "not-a-request" })
    await f.wait(() => f.responses.has("unowned"))
    expect(f.responses.get("unowned")).toMatchObject({ error: { code: -32602 } })
    const turn = (async () => { for await (const _ of executeTestTurn(f.adapter, "local", {
      parts: [{ type: "text", text: "hello" }], assistantMessageId: "assistant", agent: "build", model: { providerID: "elicitation-agent", modelID: "default" },
    }, "/repo")) {} })()
    await f.wait(() => f.promptId() !== undefined)
    f.elicit("owned", { requestId: f.promptId() }, "url")
    await f.wait(() => f.store.listQuestions("/repo").length === 1)
    await f.adapter.rejectQuestion({ ...executionBinding("local", "/repo"), upstreamSessionId: "remote" }, f.store.listQuestions("/repo")[0]!.id)
    await f.wait(() => f.responses.has("owned"))
    expect(f.responses.get("owned")).toMatchObject({ result: { action: "decline" } })
    f.finish()
    await turn
    f.elicit("expired", { requestId: f.promptId() })
    await f.wait(() => f.responses.has("expired"))
    expect(f.responses.get("expired")).toMatchObject({ error: { code: -32602 } })
  } finally { f.adapter.dispose() }
})

test("a sibling adapter cannot retire a live question, but disposal clears the pending row", async () => {
  const f = fixture()
  const sibling = fixture(f.store)
  try {
    await f.adapter.createSession("/repo", undefined, "local")
    f.elicit("pending", { sessionId: "remote" })
    await f.wait(() => f.store.listQuestions("/repo").length === 1)
    expect(await sibling.adapter.listQuestions("/repo")).toEqual([])
    expect(f.store.listQuestions("/repo")).toHaveLength(1)
    f.adapter.dispose()
    expect(f.store.listQuestions("/repo")).toEqual([])
  } finally { f.adapter.dispose(); sibling.adapter.dispose() }
})

test("a cold adapter retires durable questions whose process resolver was lost", async () => {
  const f = fixture()
  try {
    f.store.bindSession({ sessionId: "old", directory: "/repo", agentSessionId: "old-agent" })
    f.store.appendEvent({ sessionId: "old", payload: { id: "question.asked:old", type: "question.asked", properties: {
      id: "old-question", sessionID: "old", questions: [{ header: "Agent", question: "Connect", options: [] }], harnessPayload: { acpHarness: "elicitation-agent" },
    } } })
    expect(f.store.listQuestions("/repo")).toHaveLength(1)
    expect(await f.adapter.listQuestions("/repo")).toEqual([])
    expect(f.store.listQuestions("/repo")).toEqual([])
    await expect(f.adapter.replyQuestion({ ...executionBinding("old", "/repo"), upstreamSessionId: "old-agent" }, "old-question", [["accept"]])).rejects.toThrow("no longer connected")
  } finally { f.adapter.dispose() }
})


test("stopping a parent cancels descendant elicitations and preserves another session's question", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession("/repo", undefined, "local")
    await f.adapter.createSession("/repo", undefined, "other")
    const turn = (async () => { for await (const _ of executeTestTurn(f.adapter, "local", {
      parts: [{ type: "text", text: "hello" }], assistantMessageId: "assistant", agent: "build", model: { providerID: "elicitation-agent", modelID: "default" },
    }, "/repo")) {} })()
    await f.wait(() => f.promptId() !== undefined)
    f.spawn("remote", "child")
    f.spawn("child", "grandchild")
    await f.wait(() => f.store.listSessions("/repo").length === 4)
    f.elicit("child-question", { sessionId: "child" })
    f.elicit("grandchild-question", { sessionId: "grandchild" })
    f.elicit("sibling-question", { sessionId: "sibling" })
    await f.wait(() => f.store.listQuestions("/repo").length === 3)
    await f.adapter.abort({ ...executionBinding("local", "/repo"), upstreamSessionId: "remote" })
    await turn
    await f.wait(() => f.responses.has("child-question") && f.responses.has("grandchild-question"))
    expect(f.responses.get("child-question")).toMatchObject({ result: { action: "cancel" } })
    expect(f.responses.get("grandchild-question")).toMatchObject({ result: { action: "cancel" } })
    expect(f.responses.has("sibling-question")).toBe(false)
    expect(f.store.listQuestions("/repo").map((row) => row.sessionID)).toEqual(["other"])
  } finally { f.adapter.dispose() }
})
