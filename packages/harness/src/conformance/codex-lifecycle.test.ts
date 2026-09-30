import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setupConformance } from "./test-support/run"
import { codexBackend, codexEntry, makeCodexTransport, recordingBackend, type CodexBackend } from "./test-support/codex"
import { createTestServices } from "./test-support/services"
import { PINNED_CODEX } from "../../e2e/harness/pinned-codex"
import { CodexRpc } from "../transports/codex-app-server/rpc"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority } from "./test-support/memory-ports"
import type { StartInput } from "../contract"

const CATALOG_MODEL = { providerID: "codex", modelID: "gpt-5.5" }

test("a catalog model whose default summary is none still streams its reasoning summary, in the session and in a child", async () => {
  const context = await setupConformance({ name: "codex-reasoning-summary", backend: async () => ({ ...await codexBackend(), model: CATALOG_MODEL }),
    makeTransport: makeCodexTransport })
  try {
    const state = context.backend as CodexBackend
    const thinking: { text: string; child: boolean }[] = []
    const run = async (prompt: string) => {
      for await (const routed of context.transport.send(context.session, { ...context.turn(prompt), model: CATALOG_MODEL }, context.turnBroker())) {
        if (routed.event.type === "thinking-delta") thinking.push({ text: routed.event.delta, child: routed.route?.kind === "child" })
      }
    }
    state.server.scriptText({ marker: "PARENTREASON", text: "PARENTREASON", reasoning: "Parent weighs the reply" })
    await run("Reply with exactly this one token: PARENTREASON")
    state.server.scriptTool({ name: "spawn_agent", input: { task_name: "child_reason", message: "Reply with exactly this one token: CHILDREASON" },
      whenPromptIncludes: "DELEGATEREASON" })
    state.server.scriptText({ marker: "CHILDREASON", text: "CHILDREASON", reasoning: "Child weighs the task" })
    await run("Delegate once, then reply with exactly this one token: DELEGATEREASON")
    const summaries = state.server.requests.filter((row) => row.dialect === "responses" && !row.prompt.includes("conversation>"))
      .map((row) => (row.body as { reasoning?: { summary?: string } }).reasoning?.summary)
    expect(summaries.length).toBeGreaterThanOrEqual(3)
    expect(summaries.every((summary) => summary === "auto")).toBe(true)
    expect(thinking.filter((row) => !row.child).map((row) => row.text).join("")).toContain("Parent weighs the reply")
    expect(thinking.filter((row) => row.child).map((row) => row.text).join("")).toContain("Child weighs the task")
  } finally { await context.close() }
}, 90_000)

test("a Codex app-server that exits at startup fails with its exit status and the error it wrote to stderr", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-exit-"))
  const services = createTestServices()
  const missing = path.join(root, "missing-home")
  try {
    const owned = await services.spawn({ file: PINNED_CODEX, args: ["app-server", "--listen", "stdio://"], cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: root, CODEX_HOME: missing } }, { role: "harness", label: "Codex app-server", signal: new AbortController().signal })
    const rpc = new CodexRpc(owned, services.clock)
    const failure = await rpc.request("initialize", { clientInfo: { name: "claxedo", title: null, version: "0" }, capabilities: null }).then(() => undefined, (error: Error) => error)
    expect(failure?.message).toStartWith("Codex app-server exited with code 1: ")
    expect(failure?.message).toContain(`Error: CODEX_HOME points to "${missing}", but that path does not exist`)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}, 30_000)

test("a killed Codex app-server reads lost, and the next turn resumes the same thread from the same home with its history", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-lost-process", backend: recorder.backend, makeTransport: makeCodexTransport })
  try {
    const state = context.backend as CodexBackend
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: BEFORELOSS"), context.turnBroker())) {}
    const first = context.services.processes.at(-1)!
    process.kill(first.pid, "SIGKILL")
    await first.exited
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(context.transport.health!.connection(context.backend.directory, "s1").state).toBe("disconnected")
    expect(context.transport.health!.runtime(context.backend.directory, "s1")).toMatchObject({ status: "degraded", reason: "harness_process_lost" })
    const text: string[] = []
    for await (const routed of context.transport.send(context.session, context.turn("Reply with exactly this one token: AFTERLOSS"), context.turnBroker())) {
      if (routed.event.type === "text-delta") text.push(routed.event.delta)
    }
    expect(text.join("")).toContain("AFTERLOSS")
    expect(context.services.processes).toHaveLength(2)
    expect(recorder.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({
      threadId: context.session.binding.upstreamSessionId, excludeTurns: true })
    expect(recorder.received.filter((frame) => frame.method === "deprecationNotice")).toEqual([])
    expect(state.server.requests.find((row) => row.prompt.includes("AFTERLOSS"))?.prompt).toContain("BEFORELOSS")
    expect(context.transport.health!.runtime(context.backend.directory, "s1")).toEqual({ status: "ok" })
  } finally { await context.close() }
}, 90_000)

async function attachedGoalSession(state: CodexBackend, model = state.model) {
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, { binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin: state.origin! })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model }, model, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: state.credentials }
  const session = await transport.start(input, broker)
  ports.current.set("s1", { ...authority, directory: state.directory, upstreamSessionId: session.binding.upstreamSessionId })
  return { transport, ports, owner, broker, session }
}

async function eventually<T>(read: () => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return undefined
}

test("an approval Codex asks during a goal turn reaches that turn's broker, and the allowed command runs", async () => {
  const state = await codexBackend()
  const marker = path.join(state.root, "goal-approved-marker")
  state.server.scriptTool({ name: "exec_command", input: { cmd: `touch ${marker}`, sandbox_permissions: "require_escalated", justification: "Goal approval" },
    whenPromptIncludes: "GOALAPPROVE" })
  const { transport, owner, broker, session } = await attachedGoalSession(state)
  try {
    expect((await transport.goals.start(session, "Run the scripted command for GOALAPPROVE", broker)).ok).toBe(true)
    const pending = await eventually(() => owner.broker.list({ sessionId: "s1" }).find((item) => item.request.kind === "permission"))
    expect(pending?.request.kind).toBe("permission")
    expect((await owner.broker.answer(pending!.request.requestId, { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).ok).toBe(true)
    expect(await eventually(() => existsSync(marker) || undefined)).toBe(true)
    expect((await transport.goals.stop(session)).ok).toBe(true)
  } finally { await transport.dispose(); await state.close() }
}, 60_000)

test("a child a goal turn spawns runs on the session's model and asks for a reasoning summary", async () => {
  const state = await codexBackend()
  state.server.scriptTool({ name: "spawn_agent", input: { task_name: "goal_child", message: "Reply with exactly this one token: GOALCHILD" },
    whenPromptIncludes: "GOALPARENT" })
  const { transport, broker, session } = await attachedGoalSession(state, CATALOG_MODEL)
  try {
    expect((await transport.goals.start(session, "Delegate once for GOALPARENT", broker)).ok).toBe(true)
    const child = await eventually(() => state.server.requests.find((row) => row.prompt.includes("GOALCHILD") && !row.prompt.includes("GOALPARENT")))
    expect(child?.model).toBe("gpt-5.5")
    expect((child?.body as { reasoning?: { summary?: string } } | undefined)?.reasoning?.summary).toBe("auto")
    const goalTurn = state.server.requests.find((row) => row.prompt.includes("GOALPARENT"))
    expect((goalTurn?.body as { reasoning?: { summary?: string } } | undefined)?.reasoning?.summary).toBe("auto")
    expect((await transport.goals.stop(session)).ok).toBe(true)
  } finally { await transport.dispose(); await state.close() }
}, 60_000)

test("usage of a child thread Codex spawns on its own is metered to the session, not reported unbilled", async () => {
  const context = await setupConformance({ name: "codex-native-child-usage", backend: codexBackend, makeTransport: makeCodexTransport })
  const metered: string[] = []
  const meter = context.sessionBroker.meter.bind(context.sessionBroker)
  context.sessionBroker.meter = (usage) => { metered.push(usage.usage.observation?.scope ?? ""); meter(usage) }
  try {
    const state = context.backend as CodexBackend
    state.server.scriptTool({ name: "spawn_agent", namespace: "multi_agent_v1", input: { message: "Reply with exactly this one token: NATIVECHILD" },
      whenPromptIncludes: "NATIVEPARENT" })
    for await (const _event of context.transport.send(context.session, context.turn("Spawn once, then reply with exactly this one token: NATIVEPARENT"), context.turnBroker())) {}
    expect(await eventually(() => state.server.requests.find((row) => row.prompt.endsWith('"text":"Reply with exactly this one token: NATIVECHILD"}]}]')))).toBeDefined()
    expect(await eventually(() => metered.find((scope) => scope.startsWith("detached:")))).toBeDefined()
    expect(context.ports.sessionEvents.filter((row) => JSON.stringify(row.event).includes("codex.usage_unbilled"))).toEqual([])
  } finally { await context.close() }
}, 60_000)

async function conformPlugin(root: string, name: string) {
  const plugin = path.join(root, name)
  const skill = path.join(plugin, "skills", `${name}-skill`)
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true })
  await fs.mkdir(skill, { recursive: true })
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", skills: "./skills/" }))
  await fs.writeFile(path.join(skill, "SKILL.md"), `---\nname: ${name}-skill\ndescription: ${name} skill\n---\n${name}\n`)
  return { pluginInstanceId: name, root: plugin, skillNames: [], dataRoot: plugin }
}

test("adding a plugin to a session keeps its thread: the next turn resumes it in the same home with the plugin loaded", async () => {
  const context = await setupConformance({ name: "codex-plugin-change", backend: codexBackend, makeTransport: makeCodexTransport })
  try {
    const state = context.backend as CodexBackend
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: BEFOREPLUGIN"), context.turnBroker())) {}
    const home = codexEntry(context.transport, "s1").home
    const projection = { ...context.start.projection, generation: "g2", pluginRoots: [await conformPlugin(state.root, "added-plugin")] }
    expect(await context.transport.configure(context.session, { projection })).toEqual({ state: "applied" })
    const text: string[] = []
    for await (const routed of context.transport.send(context.session, context.turn("Reply with exactly this one token: AFTERPLUGIN"), context.turnBroker())) {
      if (routed.event.type === "text-delta") text.push(routed.event.delta)
    }
    expect(text.join("")).toContain("AFTERPLUGIN")
    expect(codexEntry(context.transport, "s1").home).toBe(home)
    const after = state.server.requests.find((row) => row.prompt.includes("AFTERPLUGIN"))
    expect(after?.prompt).toContain("BEFOREPLUGIN")
    expect(JSON.stringify(after?.body)).toContain("added-plugin-skill")
  } finally { await context.close() }
}, 90_000)

test("two sessions of one owner with different plugin sets share a home, and each thread loads only its own plugins", async () => {
  const context = await setupConformance({ name: "codex-plugin-isolation", backend: async () => {
    const state = await codexBackend()
    return { ...state, projection: { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [await conformPlugin(state.root, "first-plugin")] } }
  }, makeTransport: makeCodexTransport })
  try {
    const state = context.backend as CodexBackend
    const secondStart = { ...context.start, sessionId: "s2", workspaceId: "w2",
      projection: { ...context.start.projection, pluginRoots: [await conformPlugin(state.root, "second-plugin")] } }
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: context.backend.directory })
    context.ports.directories.set("s2", context.backend.directory)
    const second = await context.transport.start(secondStart, createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w2",
      directory: context.backend.directory, origin: context.backend.origin! }))
    expect(codexEntry(context.transport, "s2").home).toBe(codexEntry(context.transport, "s1").home)
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: FIRSTPLUGINS"), context.turnBroker())) {}
    for await (const _event of context.transport.send(second, context.turn("Reply with exactly this one token: SECONDPLUGINS"),
      createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin: context.backend.origin!, signal: new AbortController().signal }))) {}
    const first = JSON.stringify(state.server.requests.find((row) => row.prompt.includes("FIRSTPLUGINS"))?.body)
    const secondBody = JSON.stringify(state.server.requests.find((row) => row.prompt.includes("SECONDPLUGINS"))?.body)
    expect(first).toContain("first-plugin-skill")
    expect(first).not.toContain("second-plugin-skill")
    expect(secondBody).toContain("second-plugin-skill")
    expect(secondBody).not.toContain("first-plugin-skill")
  } finally { await context.close() }
}, 90_000)
