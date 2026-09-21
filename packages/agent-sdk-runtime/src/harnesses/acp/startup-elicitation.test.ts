import { expect, test } from "bun:test"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { AcpHarnessAdapter } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"

function fixture(holdInitialize = false) {
  const initializes: Array<string | number> = []
  let disposals = 0
  const store = new MemoryRuntimeStore()
  const creates: Array<string | number> = []
  const responses = new Map<string | number | null, AnyMessage>()
  let send!: (message: AnyMessage) => void
  const adapter = new AcpHarnessAdapter({ harness: "startup", store, connection: { kind: "process", command: "peer" }, createTransport() {
    let alive = true
    const readable = new ReadableStream<AnyMessage>({ start(controller) { send = (message) => controller.enqueue(message) } })
    const writable = new WritableStream<AnyMessage>({ write(message) {
      if (!("method" in message)) { responses.set(message.id, message); return }
      if (!("id" in message) || message.id === null) return
      if (message.method === "initialize" && holdInitialize) { initializes.push(message.id); return }
      if (message.method === "session/new") { creates.push(message.id); return }
      send({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : {} })
    } })
    return { kind: "stdio", stream: { readable, writable }, metadata: {}, get alive() { return alive }, dispose() { if (alive) disposals++; alive = false } }
  } })
  const start = (id: string): AgentSessionStartBinding => ({ sessionId: id, operationId: `operation-${id}`, workspaceId: "workspace", directory: "/work", connectionId: "startup" })
  const begin = (binding: AgentSessionStartBinding) => {
    store.sessionStarts.begin(binding)
    return adapter.createSession(binding.directory, undefined, binding.sessionId, { start: binding })
  }
  const elicit = (id: string, requestId: string | number) => send({ jsonrpc: "2.0", id, method: "elicitation/create", params: {
    requestId, mode: "form", message: "Choose before creation", requestedSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  } })
  const finish = (requestId: string | number, aid: string) => send({ jsonrpc: "2.0", id: requestId, result: { sessionId: aid } })
  const fail = (requestId: string | number) => send({ jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "Creation refused" } })
  const wait = async (predicate: () => boolean) => { for (let n = 0; n < 100 && !predicate(); n++) await Bun.sleep(5); expect(predicate()).toBe(true) }
  return { adapter, store, creates, responses, start, begin, elicit, finish, fail, wait, initializes, initialized: () => send({ jsonrpc: "2.0", id: initializes[0]!, result: { protocolVersion: 1, agentCapabilities: {} } }), disposals: () => disposals }
}

test("concurrent session/new requests own isolated durable questions before upstream IDs exist", async () => {
  const f = fixture()
  try {
    const a = f.start("a"), b = f.start("b")
    const creatingA = f.begin(a)
    await f.wait(() => f.creates.length === 1)
    const creatingB = f.begin(b)
    await f.wait(() => f.creates.length === 2)
    f.elicit("question-b", f.creates[1]!)
    f.elicit("question-a", f.creates[0]!)
    await f.wait(() => f.store.listQuestions("/work").length === 2)
    const qa = f.store.listQuestions("/work").find((row) => row.sessionID === "a")!
    const qb = f.store.listQuestions("/work").find((row) => row.sessionID === "b")!
    expect(f.store.getSession("a")).toBeNull()
    expect(f.store.getAgentSessionId("a")).toBeNull()
    await expect(f.adapter.replySessionStartQuestion(b, qa.id, [['{"label":"bad"}']])).rejects.toThrow("does not belong")
    for (const field of ["workspaceId", "directory", "connectionId", "operationId"] as const) {
      await expect(f.adapter.replySessionStartQuestion({ ...a, [field]: "other" }, qa.id, [])).rejects.toThrow("reservation")
    }
    await expect(f.adapter.replyQuestion({ sessionId: "a", upstreamSessionId: "invented", workspaceId: "workspace", directory: "/work", connectionId: "startup" }, qa.id, [])).rejects.toThrow("does not belong")
    await f.adapter.replySessionStartQuestion(a, qa.id, [['{"label":"first"}']])
    await f.adapter.replySessionStartQuestion(b, qb.id, [['{"label":"second"}']])
    await f.wait(() => f.responses.has("question-a") && f.responses.has("question-b"))
    expect(f.responses.get("question-a")).toMatchObject({ result: { action: "accept", content: { label: "first" } } })
    expect(f.responses.get("question-b")).toMatchObject({ result: { action: "accept", content: { label: "second" } } })
    f.finish(f.creates[1]!, "upstream-b"); f.finish(f.creates[0]!, "upstream-a")
    await Promise.all([creatingA, creatingB])
    expect(f.store.getAgentSessionId("a")).toBe("upstream-a")
    expect(f.store.getAgentSessionId("b")).toBe("upstream-b")
    expect(f.store.listQuestions("/work")).toEqual([])
    f.elicit("late", f.creates[0]!)
    await f.wait(() => f.responses.has("late"))
    expect(f.responses.get("late")).toMatchObject({ error: { code: -32602 } })
  } finally { f.adapter.dispose() }
})

test("newSession countdown pauses while the human considers startup elicitation", async () => {
  const previous = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
  process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "40"
  const f = fixture()
  try {
    const start = f.start("held")
    const creating = f.begin(start)
    await f.wait(() => f.creates.length === 1)
    f.elicit("held-question", f.creates[0]!)
    await f.wait(() => f.store.listQuestions("/work").length === 1)
    await Bun.sleep(120)
    expect(f.store.getSession("held")).toBeNull()
    await f.adapter.replySessionStartQuestion(start, f.store.listQuestions("/work")[0]!.id, [['{"label":"accepted"}']])
    f.finish(f.creates[0]!, "created")
    await expect(creating).resolves.toEqual({ id: "held" })
  } finally { f.adapter.dispose(); if (previous === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS; else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = previous }
})

test("failed startup cancels its question without stopping an independent start", async () => {
  const f = fixture()
  try {
    const a = f.start("failed"), b = f.start("healthy")
    const first = f.begin(a).catch((error: unknown) => error)
    await f.wait(() => f.creates.length === 1)
    const second = f.begin(b)
    await f.wait(() => f.creates.length === 2)
    f.elicit("orphan-question", f.creates[0]!)
    await f.wait(() => f.store.listQuestions("/work").length === 1)
    const question = f.store.listQuestions("/work")[0]!
    f.fail(f.creates[0]!)
    expect(String(await first)).toContain("Creation refused")
    await f.wait(() => f.responses.has("orphan-question"))
    expect(f.responses.get("orphan-question")).toMatchObject({ result: { action: "cancel" } })
    expect(f.store.listQuestions("/work")).toEqual([])
    await expect(f.adapter.replySessionStartQuestion(a, question.id, [])).rejects.toThrow("no longer connected")
    f.finish(f.creates[1]!, "healthy-upstream")
    await expect(second).resolves.toEqual({ id: "healthy" })
  } finally { f.adapter.dispose() }
})


test("process loss retires startup questions and never revives their resolvers", async () => {
  const f = fixture()
  const start = f.start("lost")
  const creating = f.begin(start).catch((error: unknown) => error)
  await f.wait(() => f.creates.length === 1)
  f.elicit("lost-question", f.creates[0]!)
  await f.wait(() => f.store.listQuestions("/work").length === 1)
  const question = f.store.listQuestions("/work")[0]!
  f.adapter.dispose()
  expect(await creating).toBeInstanceOf(Error)
  expect(f.store.listQuestions("/work")).toEqual([])
  expect(f.store.getSession("lost")).toBeNull()
  await expect(f.adapter.replySessionStartQuestion(start, question.id, [])).rejects.toThrow("no longer connected")
})

test("unattended startup still times out without inventing an executable session", async () => {
  const previous = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
  process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "20"
  const f = fixture()
  try {
    const start = f.start("stalled")
    await expect(f.begin(start)).rejects.toThrow("newSession timed out")
    expect(f.store.getSession("stalled")).toBeNull()
    f.elicit("after-timeout", f.creates[0]!)
    await f.wait(() => f.responses.has("after-timeout"))
    expect(f.responses.get("after-timeout")).toMatchObject({ result: { action: "cancel" } })
    expect(f.store.listQuestions("/work")).toEqual([])
  } finally { f.adapter.dispose(); if (previous === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS; else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = previous }
})


test("startup process idle lifetime survives human wait and releases after final creation", async () => {
  // ACP idle configuration is read at module load; isolate the short timeout.
  if (process.env.CLAXEDO_ACP_IDLE_LIFETIME_CHILD !== "1") {
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "startup process idle lifetime"], {
      env: { ...process.env, CLAXEDO_ACP_IDLE_LIFETIME_CHILD: "1", CLAXEDO_ACP_IDLE_TIMEOUT_MS: "40" },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ code, output: code ? output + errors : "" }).toEqual({ code: 0, output: "" })
    return
  }
  const f = fixture()
  try {
    const a = f.start("human"), b = f.start("sibling")
    const first = f.begin(a)
    await f.wait(() => f.creates.length === 1)
    const second = f.begin(b)
    await f.wait(() => f.creates.length === 2)
    f.elicit("human-question", f.creates[0]!)
    await f.wait(() => f.store.listQuestions("/work").length === 1)
    f.finish(f.creates[1]!, "sibling-upstream")
    await second
    await Bun.sleep(140)
    expect(f.disposals()).toBe(0)
    expect(f.store.listQuestions("/work")).toHaveLength(1)
    await f.adapter.replySessionStartQuestion(a, f.store.listQuestions("/work")[0]!.id, [['{"label":"accepted"}']])
    // session/new still owns the process after its question resolver settles.
    await Bun.sleep(100)
    expect(f.disposals()).toBe(0)
    f.finish(f.creates[0]!, "human-upstream")
    await first
    await f.wait(() => f.disposals() === 1)
    expect(f.store.listQuestions("/work")).toEqual([])
    expect(f.store.getAgentSessionId("sibling")).toBe("sibling-upstream")
  } finally { f.adapter.dispose() }
})


test("initialize questions use the reserved creation owner and suspend its deadline", async () => {
  const previous = process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS
  process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS = "40"
  const f = fixture(true), start = f.start("initializing")
  try {
    const creating = f.begin(start)
    await f.wait(() => f.initializes.length === 1)
    f.elicit("init-question", f.initializes[0]!)
    await f.wait(() => f.store.listQuestions("/work").length === 1)
    await Bun.sleep(130)
    expect(f.store.getSession(start.sessionId)).toBeNull()
    expect(f.disposals()).toBe(0)
    await expect(f.begin(f.start("competing"))).rejects.toThrow("already owned")
    const question = f.store.listQuestions("/work")[0]!
    expect(question.sessionID).toBe(start.sessionId)
    expect(question.questions[0]).toMatchObject({ custom: true, question: expect.stringContaining("requested schema") })
    expect(question.questions[0]).not.toHaveProperty("elicitation")
    await expect(f.adapter.replySessionStartQuestion({ ...start, operationId: "other" }, question.id, [['{"label":"value"}']])).rejects.toThrow("reservation")
    await f.adapter.replySessionStartQuestion(start, question.id, [['{"label":"value"}']])
    await f.wait(() => f.responses.has("init-question"))
    expect(f.responses.get("init-question")).toMatchObject({ result: { action: "accept", content: { label: "value" } } })
    f.initialized()
    await f.wait(() => f.creates.length === 1)
    f.elicit("late-init-question", f.initializes[0]!)
    await f.wait(() => f.responses.has("late-init-question"))
    expect(f.responses.get("late-init-question")).toHaveProperty("error")
    f.finish(f.creates[0]!, "actual-upstream")
    expect(await creating).toEqual({ id: start.sessionId })
  } finally { f.adapter.dispose(); if (previous === undefined) delete process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS; else process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS = previous }
})

test("unowned initialization cannot publish a question", async () => {
  const f = fixture(true)
  try {
    const creating = f.adapter.createSession("/work", undefined, "direct")
    await f.wait(() => f.initializes.length === 1)
    f.elicit("unowned", f.initializes[0]!)
    await f.wait(() => f.responses.has("unowned"))
    expect(f.responses.get("unowned")).toHaveProperty("error")
    expect(f.store.listQuestions("/work")).toEqual([])
    f.initialized()
    await f.wait(() => f.creates.length === 1)
    f.finish(f.creates[0]!, "direct-upstream")
    await creating
  } finally { f.adapter.dispose() }
})

test("disposing initialization cancels its question without fabricating a session", async () => {
  const f = fixture(true), start = f.start("lost-initialize")
  const creating = f.begin(start)
  const failed = creating.then(() => undefined, error => error)
  await f.wait(() => f.initializes.length === 1)
  f.elicit("lost", f.initializes[0]!)
  await f.wait(() => f.store.listQuestions("/work").length === 1)
  f.adapter.dispose()
  expect(await failed).toBeInstanceOf(Error)
  expect(f.store.listQuestions("/work")).toEqual([])
  expect(f.store.getSession(start.sessionId)).toBeNull()
})
