import { expect, test } from "bun:test"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { AcpHarnessAdapter, type ACPTransport } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import { cancelAdapterTurn } from "../../test-utils/cancel-turn"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"
import { workspaceDirectory } from "../../test-utils/workspace-directory"

const WORK = workspaceDirectory("work")

function fixture() {
  const store = new MemoryRuntimeStore()
  const requests: Array<{ method: string; sessionId?: string; value?: string }> = []
  const prompts = new Map<string, (stopReason?: "end_turn" | "cancelled") => void>()
  const promptBodies = new Map<string, unknown>()
  const rejectPrompts = new Map<string, () => void>()
  const rejectConfig = new Set<string>()
  const holdConfig = new Set<string>()
  const configReplies = new Map<string, () => void>()
  const holdResume = new Set<string>()
  const resumeReplies = new Map<string, () => void>()
  const cancelPrompts = new Map<string, () => void>()
  const transports: ACPTransport[] = []
  let permission!: (sessionId: string, toolCall: object) => void
  let serial = 0
  let notify!: (sessionId: string, names: string[]) => void
  let textUpdate!: (sessionId: string, text: string) => void
  let clearOptions!: (sessionId: string) => void
  let disconnect!: () => void
  const adapter = new AcpHarnessAdapter({
    harness: "test-acp", connection: { kind: "process", command: "scripted-agent" }, store,
    createTransport() {
      let send!: (message: AnyMessage) => void
      const readable = new ReadableStream<AnyMessage>({ start(c) {
        send = (message) => c.enqueue(message)
        disconnect = () => c.close()
      } })
      permission = (sessionId, toolCall) => send({ jsonrpc: "2.0", id: "permission-detail", method: "session/request_permission", params: {
        sessionId, toolCall, _meta: { permission: { version: 1, description: "Write requested file" } },
        options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
      } })
      notify = (sessionId, names) => send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: names.map((name) => ({ name, description: name })) },
      } })
      textUpdate = (sessionId, text) => send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } })
      clearOptions = (sessionId) => send({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId, update: { sessionUpdate: "config_option_update", configOptions: [] },
      } })
      const options = (value = "one") => [{ id: "model", category: "model", type: "select", name: "Model", currentValue: value,
        options: [{ value: "one", name: "One" }, { value: "two", name: "Two" }] }]
      const writable = new WritableStream<AnyMessage>({ write(message) {
        if (!("method" in message)) return
        const p = (message.params ?? {}) as { sessionId?: string; value?: string }
        requests.push({ method: message.method, ...p })
        if (message.method === "session/cancel") cancelPrompts.get(p.sessionId!)?.()
        if (!("id" in message)) return
        const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result })
        switch (message.method) {
          case "initialize": reply({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {} } } }); break
          case "session/new": {
            const sessionId = `agent-${++serial}`
            notify(sessionId, [`command-${serial}`])
            reply({ sessionId, configOptions: options() }); break
          }
          case "session/resume":
            if (holdResume.has(p.sessionId!)) resumeReplies.set(p.sessionId!, () => reply({ configOptions: options() }))
            else reply({ configOptions: options(), modes: { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto" }] } })
            break
          case "session/set_mode": reply({}); break
          case "session/set_config_option": {
            if (rejectConfig.has(p.sessionId!)) send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Model rejected" } })
            else if (holdConfig.has(p.sessionId!)) configReplies.set(p.sessionId!, () => reply({ configOptions: options(p.value) }))
            else reply({ configOptions: options(p.value) })
            break
          }
          case "session/prompt":
            promptBodies.set(p.sessionId!, message.params)
            prompts.set(p.sessionId!, (stopReason = "end_turn") => reply({ stopReason }))
            rejectPrompts.set(p.sessionId!, () => send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Prompt rejected" } }))
            break
          default: reply({})
        }
      } })
      const transport: ACPTransport = { kind: "stdio", stream: { readable, writable }, metadata: {}, alive: true, dispose() {} }
      transports.push(transport)
      return transport
    },
  })
  let turnSerial = 0
  const turn = async (id: string, modelID = "one") => {
    const turnId = ++turnSerial
    const events = []
    for await (const event of executeTestTurn(adapter, id, {
      parts: [{ type: "text", text: "/command" }], assistantMessageId: `reply-${id}-${turnId}`, userMessageId: `user-${id}-${turnId}`,
      agent: "build", model: { providerID: "test-acp", modelID: modelID },
    }, WORK)) events.push(event)
    return events
  }
  const waitFor = async (predicate: () => boolean) => {
    for (let n = 0; n < 100 && !predicate(); n++) await Bun.sleep(5)
    expect(predicate()).toBe(true)
  }
  return { adapter, store, permission: (id: string, toolCall: object) => permission(id, toolCall), text: (id: string, text: string) => textUpdate(id, text), requests, prompts, promptBodies, rejectPrompts, rejectConfig, holdConfig, configReplies, holdResume, resumeReplies, cancelPrompts, transports, turn, waitFor,
    disconnect: () => disconnect(), notify: (id: string, names: string[]) => notify(id, names), clearOptions: (id: string) => clearOptions(id) }
}

test("simultaneous session options and prompt share one authoritative restoration", async () => {
  const f = fixture()
  try {
    f.store.bindSession({ sessionId: "a", directory: WORK, agentSessionId: "agent-saved" })
    f.holdResume.add("agent-saved")
    const options = f.adapter.probeConfigOptions(WORK, executionBinding("a", WORK))
    await f.waitFor(() => f.resumeReplies.has("agent-saved"))
    const turn = f.turn("a")
    await Bun.sleep(5)
    expect(f.requests.filter((request) => request.method === "session/resume")).toHaveLength(1)
    expect(f.prompts.size).toBe(0)
    f.resumeReplies.get("agent-saved")!()
    expect(await options).toMatchObject({ resolvedModel: { id: "one" } })
    await f.waitFor(() => f.prompts.has("agent-saved"))
    f.prompts.get("agent-saved")!()
    await turn
    expect(f.requests.filter((request) => request.method === "session/resume")).toHaveLength(1)
  } finally { f.adapter.dispose() }
})

test("config options are exact-session state and new-session discovery uses an isolated directory-scoped probe", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    await f.adapter.updateSessionConfig(executionBinding("b", WORK), { model: { providerID: "test-acp", modelID: "two" } })
    expect(await f.adapter.probeConfigOptions(WORK, executionBinding("a", WORK))).toMatchObject({ resolvedModel: { id: "one" } })
    expect(await f.adapter.probeConfigOptions(WORK, executionBinding("b", WORK))).toMatchObject({ resolvedModel: { id: "two" } })
    f.clearOptions("agent-2")
    await f.waitFor(() => f.adapter.peekConfigOptions(WORK, executionBinding("b", WORK))?.options.length === 0)
    expect(await f.adapter.probeConfigOptions(WORK, executionBinding("b", WORK))).toEqual({ options: [] })
    expect(await f.adapter.probeConfigOptions(WORK, executionBinding("a", WORK))).toMatchObject({ resolvedModel: { id: "one" } })
    const active = f.turn("a")
    await f.waitFor(() => f.prompts.has("agent-1"))
    expect(await f.adapter.probeConfigOptions(WORK)).toMatchObject({ resolvedModel: { id: "one" } })
    expect(f.transports).toHaveLength(2)
    expect(f.adapter.peekConfigOptions("/another-workspace")).toBeNull()
    expect(await f.adapter.probeConfigOptions("/another-workspace")).toMatchObject({ resolvedModel: { id: "one" } })
    expect(f.transports).toHaveLength(3)
    f.prompts.get("agent-1")!()
    await active
  } finally { f.adapter.dispose() }
})

test("a rejected prompt or configuration leaves a healthy sibling running on the same connection", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    const a = f.turn("a")
    const b = f.turn("b")
    await f.waitFor(() => f.prompts.size === 2)
    f.rejectPrompts.get("agent-1")!()
    const failed = await a
    expect(failed.find((event) => event.type === "session.error")?.properties.error?.data.acpOutcome).toBe("rejected")
    expect(f.transports).toHaveLength(1)
    expect(f.store.getMessages("b").some((row) => row.info.error)).toBe(false)
    f.rejectConfig.add("agent-1")
    const configFailure = await f.turn("a", "two")
    expect(configFailure.find((event) => event.type === "session.error")?.properties.error?.data.acpOutcome).toBe("not_started")
    expect(f.requests.filter((r) => r.method === "session/prompt" && r.sessionId === "agent-1")).toHaveLength(1)
    f.prompts.get("agent-2")!()
    expect((await b).some((event) => event.type === "session.idle")).toBe(true)
    expect(f.transports).toHaveLength(1)
  } finally { f.adapter.dispose() }
})

test("a crash after recovery binding preserves context and repairs a missing divider without duplicating it", async () => {
  const f = fixture()
  const transcript = "<session-context-recovery>saved orange theme</session-context-recovery>"
  try {
    // Rehydrate the durable state after replacement binding committed but before
    // its divider or initial prompt could be delivered.
    f.store.bindSession({ sessionId: "a", directory: WORK, agentSessionId: "agent-replacement" })
    f.store.updateSessionConfig("a", { harness: { id: "test-acp", access: "native" },
      handoff: { from: { id: "test-acp", access: "native" }, pending: true, transcript, reason: "missing-session" } })
    const first = f.turn("a")
    await f.waitFor(() => f.prompts.has("agent-replacement"))
    expect(JSON.stringify(f.promptBodies.get("agent-replacement"))).toContain(transcript)
    f.rejectPrompts.get("agent-replacement")!()
    await first
    expect(f.store.getSessionConfig("a")?.handoff?.transcript).toBe(transcript)
    const dividerCount = () => f.store.getMessages("a").flatMap((row) => row.parts)
      .filter((part) => part.id === "acp-context-recovery-agent-replacement").length
    expect(dividerCount()).toBe(1)
    f.prompts.delete("agent-replacement")
    const next = f.turn("a")
    await f.waitFor(() => f.prompts.has("agent-replacement"))
    expect(JSON.stringify(f.promptBodies.get("agent-replacement"))).toContain(transcript)
    expect(dividerCount()).toBe(1)
    f.prompts.get("agent-replacement")!()
    await next
    expect(f.store.getSessionConfig("a")?.handoff).toBeNull()
    expect(dividerCount()).toBe(1)
  } finally { f.adapter.dispose() }
})

test("a lost transport records uncertain prompt outcome without resubmitting it", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    const turn = f.turn("a")
    await f.waitFor(() => f.prompts.has("agent-1"))
    f.disconnect()
    const events = await turn
    expect(events.find((event) => event.type === "session.error")?.properties.error?.data.acpOutcome).toBe("uncertain")
    expect(f.store.getMessages("a").find((row) => row.info.role === "assistant")?.info.error?.data.acpOutcome).toBe("uncertain")
    expect(f.requests.filter((r) => r.method === "session/prompt")).toHaveLength(1)
    expect(f.transports).toHaveLength(1)
  } finally { f.adapter.dispose() }
})

test("an unresolved configuration quarantines only its session until the original RPC settles", async () => {
  const before = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
  process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "15"
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    f.holdConfig.add("agent-1")
    const failed = await f.turn("a", "two")
    expect(failed.find((event) => event.type === "session.error")?.properties.error?.data.acpOutcome).toBe("uncertain")
    const blocked = await f.turn("a")
    expect(blocked.some((event) => event.type === "session.error")).toBe(true)
    expect(f.requests.filter((r) => r.method === "session/prompt" && r.sessionId === "agent-1")).toHaveLength(0)
    const sibling = f.turn("b")
    await f.waitFor(() => f.prompts.has("agent-2"))
    f.prompts.get("agent-2")!()
    await sibling
    f.holdConfig.delete("agent-1")
    f.configReplies.get("agent-1")!()
    await Bun.sleep(5)
    const recovered = f.turn("a", "two")
    await f.waitFor(() => f.prompts.has("agent-1"))
    f.prompts.get("agent-1")!()
    expect((await recovered).some((event) => event.type === "session.idle")).toBe(true)
    expect(f.transports).toHaveLength(1)
  } finally {
    f.adapter.dispose()
    if (before === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = before
  }
})

test("acknowledged cancellation settles one session while its sibling continues", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    const a = f.turn("a")
    const b = f.turn("b")
    await f.waitFor(() => f.prompts.size === 2)
    f.cancelPrompts.set("agent-1", () => f.prompts.get("agent-1")!("cancelled"))
    // The local agent acknowledged the cancel AND its prompt settled, which is
    // the only combination that makes a stdio ACP turn terminal.
    expect(await cancelAdapterTurn(f.adapter, executionBinding("a", WORK))).toEqual({ execution: "terminal", cleanup: "unknown" })
    await a
    expect(f.store.getMessages("b").some((row) => row.info.error)).toBe(false)
    f.prompts.get("agent-2")!()
    expect((await b).some((event) => event.type === "session.idle")).toBe(true)
    expect(f.transports).toHaveLength(1)
  } finally { f.adapter.dispose() }
})

test("unacknowledged cancellation does not dispose a healthy sibling or replay the prompt", async () => {
  const before = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
  process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "15"
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    const a = f.turn("a")
    const b = f.turn("b")
    await f.waitFor(() => f.prompts.size === 2)
    expect(await cancelAdapterTurn(f.adapter, executionBinding("a", WORK))).toMatchObject({ error: { code: "provider_unreachable" } })
    f.prompts.get("agent-2")!()
    expect((await b).some((event) => event.type === "session.idle")).toBe(true)
    expect(f.transports).toHaveLength(1)
    expect(f.requests.filter((r) => r.method === "session/prompt" && r.sessionId === "agent-1")).toHaveLength(1)
    // The old request eventually acknowledges cancellation. No duplicate was
    // submitted while it remained unresolved.
    f.prompts.get("agent-1")!("cancelled")
    await a
    expect(f.store.consumeRecoveryError("a")).toBeUndefined()
  } finally {
    f.adapter.dispose()
    if (before === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = before
  }
})

test("two sessions on one ACP process reach the agent concurrently and changing one model does not restart it", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    const a = f.turn("a")
    const b = f.turn("b")
    await f.waitFor(() => f.prompts.size === 2)
    expect(f.transports).toHaveLength(1)
    await f.adapter.updateSessionConfig(executionBinding("b", WORK), { model: { providerID: "test-acp", modelID: "two" } })
    expect(f.requests.filter((r) => r.method === "session/set_config_option").at(-1)).toMatchObject({ sessionId: "agent-2", value: "two" })
    expect(f.transports).toHaveLength(1)
    f.prompts.get("agent-2")!()
    await b
    expect(f.store.getMessages("a").some((row) => row.info.role === "assistant" && row.info.time?.completed)).toBe(false)
    f.prompts.get("agent-1")!()
    await a
  } finally { f.adapter.dispose() }
})

test("command discovery before session/new response persists per session and idle updates can clear it", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    expect(f.store.getSession("a")?.commands?.map((c) => c.name)).toEqual(["command-1"])
    expect(f.store.getSession("b")?.commands?.map((c) => c.name)).toEqual(["command-2"])
    f.notify("agent-1", [])
    await f.waitFor(() => f.store.getSession("a")?.commands?.length === 0)
    expect(f.store.getSession("b")?.commands?.map((c) => c.name)).toEqual(["command-2"])
  } finally { f.adapter.dispose() }
})

test("negotiated fork support survives idle process disposal and cold discovery does not steal session restoration", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    const internals = f.adapter as unknown as { processes: Map<string, { proc: { dispose(): void } | null }> }
    const entry = [...internals.processes.values()][0]
    entry.proc!.dispose()
    expect((await f.adapter.readHarnessCapabilities(WORK, { sessionId: "a" })).fork).toBe(true)
    expect(f.transports).toHaveLength(1)
    // A fresh adapter has no cached negotiation. Probe discovery must not count
    // as restoring the actual agent session before the next prompt.
    f.adapter.dispose()
    const cold = fixture()
    try {
      cold.store.bindSession({ sessionId: "a", directory: WORK, agentSessionId: "agent-saved" })
      cold.store.bindSession({ sessionId: "b", directory: WORK, agentSessionId: "agent-sibling" })
      expect((await cold.adapter.readHarnessCapabilities(WORK, { sessionId: "a" })).fork).toBe(true)
      const turn = cold.turn("a")
      await cold.waitFor(() => cold.prompts.has("agent-saved"))
      expect(cold.requests.some((r) => r.method === "session/resume" && r.sessionId === "agent-saved")).toBe(true)
      cold.prompts.get("agent-saved")!()
      await turn
      const sibling = cold.turn("b")
      await cold.waitFor(() => cold.prompts.has("agent-sibling"))
      expect(cold.requests.filter((r) => r.method === "session/resume").map((r) => r.sessionId))
        .toEqual(["agent-saved", "agent-sibling"])
      cold.prompts.get("agent-sibling")!()
      await sibling
    } finally { cold.adapter.dispose() }
  } finally { f.adapter.dispose() }
})


test("an unacknowledged cancellation retains the original turn and records late output", async () => {
  const promptTimeout = process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS
  const cancelTimeout = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
  process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = "20"
  process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "20"
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    await f.adapter.createSession(WORK, undefined, "b")
    let settled = false
    const turn = f.turn("a").then((events) => { settled = true; return events })
    await f.waitFor(() => f.store.getSession("a")?.status === "recovering")
    expect(settled).toBe(false)
    const second = await f.turn("a")
    expect(second.some((event) => event.type === "session.error")).toBe(true)
    const sibling = f.turn("b")
    await f.waitFor(() => f.prompts.has("agent-2"))
    f.prompts.get("agent-2")!()
    await sibling
    f.text("agent-1", "Authoritative late output after cancellation timeout")
    await f.waitFor(() => JSON.stringify(f.store.getMessages("a")).includes("Authoritative late output"))
    f.prompts.get("agent-1")!("cancelled")
    const events = await turn
    expect(events.some((event) => event.type === "session.status" && event.properties.status.type === "recovering" && event.properties.status.kind === "uncertain_execution")).toBe(true)
    expect(events.some((event) => event.type === "session.error")).toBe(false)
    expect(f.requests.filter((request) => request.method === "session/prompt" && request.sessionId === "agent-1")).toHaveLength(1)
    expect(f.transports).toHaveLength(1)
  } finally {
    f.adapter.dispose()
    if (promptTimeout === undefined) delete process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = promptTimeout
    if (cancelTimeout === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = cancelTimeout
  }
})


test("permission wire input preserves command, paths and complete agent details in the durable request", async () => {
  const f = fixture()
  try {
    await f.adapter.createSession(WORK, undefined, "a")
    const turn = f.turn("a")
    await f.waitFor(() => f.prompts.has("agent-1"))
    const toolCall = { toolCallId: "call-1", title: "Run command", kind: "execute", rawInput: { command: "printf '<script>data</script>' > /work/result", cwd: WORK }, locations: [{ path: "/work/result" }], content: [{ type: "content", content: { type: "text", text: "Additional agent detail" } }] }
    f.permission("agent-1", toolCall)
    await f.waitFor(() => f.store.listPermissions(WORK).length === 1)
    const row = f.store.listPermissions(WORK)[0]
    expect(row.metadata.command).toBe(toolCall.rawInput.command)
    expect(row.metadata.acpToolCall).toEqual(toolCall)
    expect(row.metadata.acpRequestMeta).toEqual({ permission: { version: 1, description: "Write requested file" } })
    expect(row.patterns).toEqual(["/work/result"])
    await f.adapter.respondPermission(executionBinding("a", WORK), row.id, "allow_once")
    f.prompts.get("agent-1")!()
    await turn
  } finally { f.adapter.dispose() }
})


test("cold permission reads and writes restore the owned session without creating a replacement", async () => {
  const f = fixture()
  try {
    f.store.bindSession({ sessionId: "saved", directory: WORK, agentSessionId: "agent-saved" })
    const binding = { ...executionBinding("saved", WORK), upstreamSessionId: "agent-saved" }
    expect(await f.adapter.listPermissionModes(binding)).toMatchObject({ currentModeId: "ask" })
    expect(await f.adapter.setPermissionMode(binding, "auto")).toMatchObject({ currentModeId: "auto" })
    expect(f.requests.filter((row) => row.method === "session/resume")).toHaveLength(1)
    expect(f.requests.some((row) => row.method === "session/new")).toBe(false)
  } finally { f.adapter.dispose() }
})
