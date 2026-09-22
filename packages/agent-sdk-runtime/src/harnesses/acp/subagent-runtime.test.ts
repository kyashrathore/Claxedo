import { expect, test } from "bun:test"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { AcpHarnessAdapter } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"

test("negotiated children traverse ACP wire and isolated child transcripts", async () => {
  const store = new MemoryRuntimeStore()
  let sendLate!: (message: AnyMessage) => void
  const replies: unknown[] = []
  let prompts = 0
  let advertised: unknown
  let notifyLate!: (sessionId: string, update: Record<string, unknown>) => void
  let disconnect!: () => void
  const adapter = new AcpHarnessAdapter({
    harness: "children-test", connection: { kind: "process", command: "scripted-agent" }, store,
    createTransport: () => {
      let send!: (message: AnyMessage) => void
      const readable = new ReadableStream<AnyMessage>({ start(controller) { send = (message) => controller.enqueue(message); disconnect = () => controller.close() } })
      const notify = (sessionId: string, update: Record<string, unknown>) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
      sendLate = send
      notifyLate = notify
      const emitTree = () => {
          notify("root-agent", { sessionUpdate: "subagent_spawned", subagentSessionId: "child-agent", name: "Reviewer", task: "Review implementation", capabilities: {} })
          notify("child-agent", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Child-only output" } })
          notify("child-agent", { sessionUpdate: "subagent_spawned", subagentSessionId: "grandchild-agent", name: "Checker", task: "Check tests", capabilities: {} })
          notify("grandchild-agent", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Grandchild-only output" } })
          notify("child-agent", { sessionUpdate: "subagent_state_update", subagentSessionId: "grandchild-agent", state: "completed" })
          notify("root-agent", { sessionUpdate: "subagent_state_update", subagentSessionId: "child-agent", state: "completed" })
      }
      const writable = new WritableStream<AnyMessage>({ write(message) {
        if (!("method" in message)) { replies.push(message); return }
        if (!("id" in message)) return
        const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
        if (message.method === "initialize") {
          advertised = message.params
          reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } })
        } else if (message.method === "session/new") reply({ sessionId: "root-agent" })
        else if (message.method === "session/load") { emitTree(); reply({}) }
        else if (message.method === "session/prompt") {
          if (++prompts === 1) emitTree()
          notify("root-agent", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Parent-only output" } })
          reply({ stopReason: "end_turn" })
        } else reply({})
      } })
      return { kind: "stdio", stream: { readable, writable }, metadata: {}, alive: true, dispose() {} }
    },
  })
  try {
    await adapter.createSession("/work", "Root", "root-local")
    const events = []
    for await (const event of executeTestTurn(adapter, "root-local", { parts: [{ type: "text", text: "review" }], agent: "build", model: { providerID: "children-test", modelID: "default" }, assistantMessageId: "assistant", userMessageId: "user" }, "/work")) events.push(event)
    expect(JSON.stringify(advertised)).toContain("nativeSubagentSessions")
    expect(events.some((event) => event.type === "session.error")).toBe(false)
    const sessions = store.listSessions("/work")
    const child = sessions.find((session) => session.parentID === "root-local")!
    expect(child).toBeDefined()
    const grandchild = sessions.find((session) => session.parentID === child.id)!
    expect(grandchild).toBeDefined()
    expect(store.getAgentSessionId(child.id)).toBe("child-agent")
    expect(store.getAgentSessionId(grandchild.id)).toBe("grandchild-agent")
    expect(JSON.stringify(store.getMessages(child.id))).toContain("Child-only output")
    expect(JSON.stringify(store.getMessages(grandchild.id))).toContain("Grandchild-only output")
    expect(JSON.stringify(store.getMessages("root-local"))).not.toContain("Child-only output")
    expect(JSON.stringify(store.getMessages(child.id))).not.toContain("Grandchild-only output")
    expect(store.listSubagents("root-local")[0]?.status).toBe("completed")
    // A child can keep working after its parent's prompt response.
    notifyLate("root-agent", { sessionUpdate: "subagent_spawned", subagentSessionId: "late-child", name: "Background", task: "Continue work", capabilities: {} })
    notifyLate("late-child", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After parent completion" } })
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(5)
      expect(predicate()).toBe(true)
    }
    await waitFor(() => store.listSessions("/work").some((session) => store.getAgentSessionId(session.id) === "late-child" && JSON.stringify(store.getMessages(session.id)).includes("After parent completion")))
    sendLate({ jsonrpc: "2.0", id: "child-permission", method: "session/request_permission", params: {
      sessionId: "late-child", toolCall: { toolCallId: "child-tool", title: "Read project", kind: "read" },
      options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
    } })
    await waitFor(() => store.listPermissions("/work").length === 1)
    const permission = store.listPermissions("/work")[0]
    expect(permission.sessionID).toBe("root-local")
    await adapter.respondPermission(executionBinding("root-local", "/work"), permission.id, "allow_once")
    await waitFor(() => replies.some((reply) => JSON.stringify(reply).includes("child-permission")))
    expect(JSON.stringify(replies)).toContain('"optionId":"allow"')
    disconnect()
    await waitFor(() => store.listSubagents("root-local").some((row) => row.providerId === "late-child" && row.status === "interrupted"))
    expect(store.listSubagents("root-local").find((row) => row.providerId === "child-agent")?.status).toBe("completed")
    const beforeResume = JSON.stringify(store.getMessages(child.id))
    for await (const _event of executeTestTurn(adapter, "root-local", { parts: [{ type: "text", text: "resume" }], agent: "build", model: { providerID: "children-test", modelID: "default" }, assistantMessageId: "assistant-2", userMessageId: "user-2" }, "/work")) {}
    expect(JSON.stringify(store.getMessages(child.id))).toBe(beforeResume)
    expect(store.listSessions("/work").filter((session) => store.getAgentSessionId(session.id) === "child-agent")).toHaveLength(1)


  } finally { await adapter.dispose() }
})

import { ACPProcess } from "./process"

test.each([true, false])("subagent negotiation=%s rejects spoofed lineage without losing the connection", async (negotiated) => {
  let send!: (message: AnyMessage) => void
  const received: unknown[] = []
  const readable = new ReadableStream<AnyMessage>({ start(controller) { send = (message) => controller.enqueue(message) } })
  const notify = (sessionId: string, update: Record<string, unknown>) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
  const writable = new WritableStream<AnyMessage>({ write(message) {
    if (!("method" in message) || !("id" in message)) return
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
    if (message.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: {}, ...(negotiated ? { _meta: { jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } } } } : {}) })
    else if (message.method === "session/prompt") {
      notify("root", { sessionUpdate: "subagent_spawned", subagentSessionId: "child", name: "Child", task: "Work", capabilities: {} })
      notify("other-root", { sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "failed" })
      notify("child", { sessionUpdate: "subagent_spawned", subagentSessionId: "root", name: "Cycle", task: "Invalid", capabilities: {} })
      notify("root", { sessionUpdate: "subagent_state_update", subagentSessionId: "child", state: "completed" })
      reply({ stopReason: "end_turn" })
    } else reply({})
  } })
  const proc = new ACPProcess("/work", "test", [], "default", () => [], () => {}, () => ({ kind: "stdio", stream: { readable, writable }, metadata: {}, alive: true, dispose() {} }), () => ({}))
  try {
    await proc.initialize()
    proc.listenSubagents("root", async (event) => { received.push(event) })
    await proc.prompt("root", { parts: [{ type: "text", text: "go" }], assistantMessageId: "a", agent: "build", model: { providerID: "test", modelID: "default" } }, () => {}, "/work")
    expect(received).toHaveLength(negotiated ? 2 : 0)
    expect(proc.alive).toBe(true)
    if (negotiated) expect(proc.rootAgentSessionId("child")).toBe("root")
  } finally { await proc.dispose() }
})
