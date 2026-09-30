import { scriptedTransport, type Frame } from "../transports/codex-app-server/test-support/transport"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { runConformance, setupConformance } from "./test-support/run"
import { codexBackend as backend, codexEntry, entryHome, hashes, makeCodexTransport as makeTransport, OWNER_KEY, ownLoginContext, recordingBackend, type CodexBackend } from "../../e2e/harness/codex-conformance"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../e2e/harness/config"
import { PINNED_CODEX } from "../../e2e/harness/pinned-codex"
import { startScriptedMcpServer } from "../../e2e/harness/scripted-mcp-server"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import type { RpcMessage } from "../transports/codex-app-server/rpc"
import { answerCodexRequest } from "../transports/codex-app-server/requests"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import type { PermissionDecision } from "@claxedo/agent-runtime-contract"
import type { PendingRequest, RequestAnswer, RoutedEvent, StartInput, TurnBroker, TurnInput } from "../contract"

runConformance({ name: "codex-app-server", backend, makeTransport })

test("Codex Stop on a turn that ran a command terminates its background terminals and verifies them clear", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-stop-command", backend: recorder.backend, makeTransport })
  try {
    const state = context.backend as CodexBackend
    state.server.scriptTool({ name: "exec_command", input: { cmd: "sleep 120", yield_time_ms: 1000 } })
    const release = context.backend.hold!("Process running with session ID")
    const events: unknown[] = []
    const running = (async () => {
      for await (const event of context.transport.send(context.session, context.turn("Run the scripted command CODEXSTOPCOMMAND"), context.turnBroker())) events.push(event.event)
    })()
    await context.backend.held!("Process running with session ID")
    const outcome = await context.transport.cancel(context.session, { turnId: "t1", assistantMessageId: "a1" },
      { at: Date.now() + 15_000, signal: new AbortController().signal })
    release()
    await running
    expect(outcome.execution).toBe("terminal")
    expect(outcome.cleanup).toBe("verified_clear")
    expect(recorder.frames.some((frame) => frame.method === "turn/interrupt")).toBe(true)
    expect(recorder.frames.filter((frame) => frame.method === "thread/backgroundTerminals/list").length).toBeGreaterThanOrEqual(2)
    expect(recorder.frames.some((frame) => frame.method === "thread/backgroundTerminals/terminate")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("Codex goal pause and stop proceed after a goal turn ran a command, once its terminals verify clear", async () => {
  const context = await setupConformance({ name: "codex-goal-command", backend, makeTransport })
  try {
    const state = context.backend as CodexBackend
    state.server.scriptTool({ name: "exec_command", input: { cmd: "sleep 120", yield_time_ms: 1000 } })
    const release = context.backend.hold!("Process running with session ID")
    expect((await context.transport.goals!.start(context.session, "Run the scripted command CODEXGOALCOMMAND", context.sessionBroker)).ok).toBe(true)
    await context.backend.held!("Process running with session ID")
    expect((await context.transport.goals!.pause(context.session)).ok).toBe(true)
    expect(context.ports.sessionEvents.some((row) => (row.event as { type?: string; code?: string }).code === "codex.background_commands_unverified")).toBe(false)
    expect((await context.transport.goals!.read(context.session))?.status).toBe("paused")
    expect((await context.transport.goals!.stop(context.session)).ok).toBe(true)
    expect(await context.transport.goals!.read(context.session)).toBeNull()
    release()
  } finally { await context.close() }
}, 60_000)

const codexModeParameters = {
  "read-only": { approvalPolicy: "never", sandbox: "readOnly" },
  "workspace-write": { approvalPolicy: "on-request", sandbox: "workspaceWrite" },
  untrusted: { approvalPolicy: "untrusted", sandbox: "workspaceWrite" },
  "full-access": { approvalPolicy: "never", sandbox: "dangerFullAccess" },
} as const

test("Codex offers today's four permission modes and applies the selected one to thread start and each turn", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-modes", backend: recorder.backend, makeTransport })
  try {
    const state = await context.transport.config!.permissionModes({ session: context.session })
    expect(state.modes.map((mode) => mode.id)).toEqual(Object.keys(codexModeParameters))
    expect(state).toMatchObject({ currentModeId: "workspace-write", appliesFrom: "next-turn" })
    await expect(context.transport.config!.setPermissionMode(context.session, "bogus")).rejects.toMatchObject({ transport: "codex", code: "configuration" })
    expect(recorder.frames.find((frame) => frame.method === "thread/start")?.params).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" })
    for (const [modeId, expected] of Object.entries(codexModeParameters)) {
      expect((await context.transport.config!.setPermissionMode(context.session, modeId)).currentModeId).toBe(modeId)
      const before = recorder.frames.filter((frame) => frame.method === "turn/start").length
      const events = []
      for await (const event of context.transport.send(context.session, context.turn(`Reply with exactly this one token: MODE${before}`), context.turnBroker())) events.push(event)
      expect(events.some((event) => event.event.type === "finish")).toBe(true)
      const started = recorder.frames.filter((frame) => frame.method === "turn/start")[before]
      expect(started?.params?.approvalPolicy).toBe(expected.approvalPolicy)
      expect((started?.params?.sandboxPolicy as { type?: string } | undefined)?.type).toBe(expected.sandbox)
    }
    expect((await context.transport.config!.permissionModes({ session: context.session })).currentModeId).toBe("full-access")
    await context.transport.close(context.session)
    const attached = await context.transport.attach({ ...context.start, config: { ...context.start.config, permissionMode: "read-only" }, binding: context.session.binding, upstreamHasTurns: true }, context.sessionBroker)
    expect(recorder.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ approvalPolicy: "never", sandbox: "read-only" })
    await context.transport.close(attached)
  } finally { await context.close() }
}, 90_000)

const HOST_CHILD = { kind: "claxedo.subagent", subagentKey: "subagent_codex", sessionId: "child-codex", status: "running" }

test("a Codex model without Codex's own multi-agent tools is offered no Claxedo spawn tool and starts a Codex child through create_subagent", async () => {
  let admitHostChild = () => {}
  const mcp = await startScriptedMcpServer({ name: "create_subagent", description: "Start a subagent session on a harness",
    inputSchema: { type: "object", properties: { harness: { type: "string" }, prompt: { type: "string" } }, required: ["harness", "prompt"] },
    result: () => {
      admitHostChild()
      return { content: [{ type: "text", text: JSON.stringify(HOST_CHILD) }] }
    } })
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-create-subagent",
    backend: async () => ({ ...(await recorder.backend()), model: { providerID: "codex", modelID: "gpt-5.5" },
      configureServices: (services) => { services.firstPartyMcp = (_sessionId, locality) => locality === "local" ? { kind: "http", name: "claxedo", url: mcp.url } : undefined } }),
    makeTransport })
  admitHostChild = () => context.sessionBroker.associateChild(HOST_CHILD.subagentKey, { sessionId: HOST_CHILD.sessionId, assistantMessageId: "child-a1", created: 10 })
  try {
    const server = (context.backend as CodexBackend).server
    await context.transport.config!.update(context.session, { permissionMode: "full-access" })
    server.scriptTool({ name: "tool_search", format: "tool_search", input: { query: "create_subagent" }, whenPromptIncludes: "CODEXFINDSPAWN" })
    for await (const _event of context.transport.send(context.session, context.turn("Find the subagent tool CODEXFINDSPAWN"), context.turnBroker())) {}
    const offered = server.requests.filter((request) => request.prompt.includes("CODEXFINDSPAWN")).flatMap((request) => request.tools)
    expect(offered.filter((tool) => tool.call.name === "spawn_agent")).toEqual([])
    const create = offered.find((tool) => tool.call.name === "create_subagent")
    expect(create?.call).toEqual({ name: "create_subagent", namespace: expect.stringMatching(/^mcp__claxedo/) })
    server.scriptTool({ ...create!.call, input: { harness: "codex", prompt: "Inspect the workspace" }, whenPromptIncludes: "CODEXHOSTSPAWN" })
    const events: RoutedEvent[] = []
    for await (const routed of context.transport.send(context.session, { ...context.turn("Start a Codex subagent CODEXHOSTSPAWN", "u2"),
      turnId: "t2", assistantMessageId: "a2" }, context.turnBroker())) events.push(routed)
    expect(mcp.calls).toEqual([{ name: "create_subagent", arguments: { harness: "codex", prompt: "Inspect the workspace" } }])
    const call = events.find((routed) => routed.event.type === "tool-start" && routed.event.toolName.includes("create_subagent"))
    expect(context.ports.subagents).toContainEqual(expect.objectContaining({ toolCallRole: "spawn", providerKind: "claxedo",
      childSessionId: "child-codex", subagentKey: "subagent_codex", toolCallId: call?.event.type === "tool-start" ? call.event.toolCallId : "missing" }))
    expect(recorder.frames.filter((frame) => frame.method === "thread/start").map((frame) => frame.params?.dynamicTools)).toEqual([undefined])
    expect(recorder.received.some((frame) => frame.method === "item/tool/call")).toBe(false)
  } finally {
    await context.close()
    await mcp.close()
  }
}, 90_000)

async function titledSession(recorder: ReturnType<typeof recordingBackend>) {
  const context = await setupConformance({ name: "codex-title", backend: recorder.backend, makeTransport })
  for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: CODEXTITLE"), context.turnBroker())) {}
  const request = { directory: context.backend.directory, system: SESSION_TITLE_SYSTEM_PROMPT,
    user: "<conversation>\nUser: Reply with exactly this one token: CODEXTITLE\n</conversation>", signal: AbortSignal.timeout(20_000) }
  return { context, request }
}

test("Codex names a session through an ephemeral read-only side thread and writes renames back", async () => {
  const recorder = recordingBackend()
  const { context, request } = await titledSession(recorder)
  try {
    expect(await context.transport.naming!.generateTitle!(context.session, request)).toBe("Session CODEXTITLE")
    const starts = recorder.frames.filter((frame) => frame.method === "thread/start")
    expect(starts[1]?.params).toMatchObject({ ephemeral: true, approvalPolicy: "never", sandbox: "read-only", developerInstructions: SESSION_TITLE_SYSTEM_PROMPT })
    const titleTurn = recorder.frames.filter((frame) => frame.method === "turn/start")[1]
    expect(titleTurn?.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } })
    expect(titleTurn?.params?.outputSchema).toBeDefined()
    expect(titleTurn?.params?.threadId).not.toBe(context.session.binding.upstreamSessionId)
    expect(recorder.frames.find((frame) => frame.method === "thread/archive")?.params).toEqual({ threadId: titleTurn?.params?.threadId })
    await context.transport.naming!.rename!(context.session, "Renamed by test")
    expect(recorder.frames.find((frame) => frame.method === "thread/name/set")?.params).toEqual({ threadId: context.session.binding.upstreamSessionId, name: "Renamed by test" })
    expect((await context.transport.capabilities({ directory: context.backend.directory })).titles).toBe("side-request")
  } finally { await context.close() }
}, 90_000)

test("Codex meters a side thread's usage outside a turn to the session's last turn", async () => {
  const recorder = recordingBackend()
  const { context, request } = await titledSession(recorder)
  const metered: { assistantMessageId: string; observation?: { kind?: string; scope?: string } }[] = []
  const meter = context.sessionBroker.meter.bind(context.sessionBroker)
  context.sessionBroker.meter = (usage) => { metered.push({ assistantMessageId: usage.assistantMessageId, observation: usage.usage.observation }); meter(usage) }
  try {
    await context.transport.naming!.generateTitle!(context.session, request)
    expect(metered.length).toBeGreaterThan(0)
    expect(metered.map((row) => [row.assistantMessageId, row.observation?.kind, row.observation?.scope?.split(":")[0]]))
      .toEqual(metered.map(() => ["a1", "delta", "title"]))
  } finally { await context.close() }
}, 90_000)

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lp8AAAAASUVORK5CYII="
const TEXT = "Codex attachment reached the harness\n"

test("Codex materializes every attachment into the workspace with a path line, and images also as native input", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-attachments", backend: recorder.backend, makeTransport })
  try {
    const state = context.backend as CodexBackend
    const base = context.turn("Review the image and text file. Reply with exactly this one token: CODEXATTACH")
    const turn: TurnInput = { ...base, prompt: { ...base.prompt, parts: [...base.prompt.parts,
      { type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${PNG}` },
      { type: "file", mime: "text/plain", filename: "notes.txt", url: `data:text/plain;base64,${Buffer.from(TEXT).toString("base64")}` },
    ] } }
    const events = []
    for await (const event of context.transport.send(context.session, turn, context.turnBroker())) events.push(event)
    expect(events.some((item) => item.event.type === "finish")).toBe(true)
    const folder = path.join(state.directory, ".claxedo", "attachments")
    const files = (await fs.readdir(folder)).filter((name) => name !== ".gitignore")
    const png = files.find((name) => name.endsWith("-shot.png"))
    const txt = files.find((name) => name.endsWith("-notes.txt"))
    expect([png, txt].every(Boolean)).toBe(true)
    expect(await fs.readFile(path.join(folder, txt!), "utf8")).toBe(TEXT)
    expect((await fs.readFile(path.join(folder, png!))).equals(Buffer.from(PNG, "base64"))).toBe(true)
    expect(await fs.readFile(path.join(folder, ".gitignore"), "utf8")).toBe("*\n")
    const request = state.server.requests.find((row) => row.prompt.includes("CODEXATTACH"))
    expect(request?.prompt).toContain(`Attached file (image/png): ${path.join(folder, png!)}`)
    expect(request?.prompt).toContain(`Attached file (text/plain): ${path.join(folder, txt!)}`)
    const input = recorder.frames.find((frame) => frame.method === "turn/start")?.params?.input as { type: string; path?: string }[]
    expect(input.some((part) => part.type === "localImage" && part.path === path.join(folder, png!))).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("Codex draft configuration probes model/list with the owner's resolved credentials", async () => {
  const state = await backend()
  const transport = new CodexAppServerTransport(createTestServices(), {
    binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env,
  })
  try {
    const target = { draft: { workspaceId: "ws", directory: state.directory, locality: "local" as const,
      owner: state.owner, credentials: state.credentials, config: { harness: { id: "codex", access: "native" as const } },
      projection: { generation: "test", mcpServers: [], pluginRoots: [], notApplied: [] } } }
    const preview = await transport.config.options(target, "probe")
    expect(preview.options.length).toBeGreaterThan(0)
    const homes = await fs.readdir(path.join(state.root, "homes"))
    expect(homes).toHaveLength(1)
    expect(await transport.config.options(target, "probe")).toEqual(preview)
    expect(await fs.readdir(path.join(state.root, "homes"))).toEqual(homes)
  } finally { await transport.dispose(); await state.close() }
}, 60_000)


test("two concurrent own-login sessions share one Claxedo home, see the owner's config, resume their own threads, and leave the owner's home byte-identical", async () => {
  const { context, ownerHome, mcpRequests, homes } = await ownLoginContext("codex-shared-home")
  try {
    const before = await hashes(ownerHome)
    const first = context.session
    const secondStart = { ...context.start, sessionId: "s2", workspaceId: "w2" }
    context.ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2", directory: context.backend.directory })
    context.ports.directories.set("s2", context.backend.directory)
    const secondBroker = createSessionBroker(context.owner, { sessionId: "s2", workspaceId: "w2", directory: context.backend.directory, origin: context.backend.origin! })
    const second = await context.transport.start(secondStart, secondBroker)
    expect(entryHome(context.transport, "s2")).toBe(entryHome(context.transport, "s1"))
    expect(await fs.readdir(homes)).toHaveLength(1)
    expect(mcpRequests.length).toBeGreaterThan(0)
    const secondTurnBroker = () => createTurnBroker(context.owner, { authority: context.ports.current.get("s2")!, origin: context.backend.origin!, signal: new AbortController().signal })
    for await (const _event of context.transport.send(first, context.turn("Reply with exactly this one token: SHAREDONE"), context.turnBroker())) {}
    for await (const _event of context.transport.send(second, context.turn("Reply with exactly this one token: SHAREDTWO"), secondTurnBroker())) {}
    const state = context.backend as CodexBackend
    expect(state.server.requests.find((row) => row.prompt.includes("SHAREDONE"))?.model).toBe("gpt-4.1")
    expect(state.server.requests.find((row) => row.prompt.includes("SHAREDTWO"))?.authorization).toContain(OWNER_KEY)
    await context.transport.close(first)
    await context.transport.close(second)
    const firstAgain = await context.transport.attach({ ...context.start, binding: first.binding, upstreamHasTurns: true }, context.sessionBroker)
    const secondAgain = await context.transport.attach({ ...secondStart, binding: second.binding, upstreamHasTurns: true }, secondBroker)
    expect(entryHome(context.transport, "s1")).toBe(entryHome(context.transport, "s2"))
    const collected: string[] = []
    for await (const event of context.transport.send(firstAgain, context.turn("Reply with exactly this one token: RESUMEDONE"), context.turnBroker())) {
      if (event.event.type === "text-delta") collected.push(event.event.delta)
    }
    for await (const event of context.transport.send(secondAgain, context.turn("Reply with exactly this one token: RESUMEDTWO"), secondTurnBroker())) {
      if (event.event.type === "text-delta") collected.push(event.event.delta)
    }
    expect(collected.join("")).toContain("RESUMEDONE")
    expect(collected.join("")).toContain("RESUMEDTWO")
    expect(await hashes(ownerHome)).toEqual(before)
    expect(await fs.readdir(ownerHome)).not.toContain("sessions")
  } finally { await context.close() }
}, 120_000)

test("a login the app-server persists through the linked auth.json lands in the owner's file and nowhere else", async () => {
  const { context, ownerHome } = await ownLoginContext("codex-auth-link")
  try {
    const { "auth.json": _auth, ...before } = await hashes(ownerHome)
    const home = entryHome(context.transport, "s1")
    expect((await fs.lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(true)
    const rpc = codexEntry(context.transport, "s1").rpc
    expect(await rpc.request("account/login/start", { type: "apiKey", apiKey: "owner-key-2" })).toEqual({ type: "apiKey" })
    expect(await fs.readFile(path.join(ownerHome, "auth.json"), "utf8")).toContain("owner-key-2")
    expect((await fs.lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(true)
    const { "auth.json": _after, ...after } = await hashes(ownerHome)
    expect(after).toEqual(before)
    const stray = (await fs.readdir(home, { recursive: true })).filter((name) => name.endsWith("auth.json") && name !== "auth.json")
    expect(stray).toEqual([])
  } finally { await context.close() }
}, 60_000)

test("a foreign harness projection leaves Codex on the owner's own login and its auth file untouched", async () => {
  const { context, ownerHome } = await ownLoginContext("codex-foreign-projection", {
    "claude-sdk": { baseUrl: "http://127.0.0.1:9/foreign", placeholder: "foreign-placeholder", authMode: "api-key" },
  })
  try {
    const auth = path.join(ownerHome, "auth.json")
    const before = await fs.readFile(auth, "utf8")
    expect(await fs.realpath(path.join(entryHome(context.transport, "s1"), "auth.json"))).toBe(await fs.realpath(auth))
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: FOREIGNPROJECTION"), context.turnBroker())) {}
    const state = context.backend as CodexBackend
    expect(state.server.requests.find((row) => row.prompt.includes("FOREIGNPROJECTION"))?.authorization).toContain(OWNER_KEY)
    expect(state.server.requests.filter((row) => row.authorization?.includes("foreign-placeholder"))).toEqual([])
    expect(await fs.readFile(auth, "utf8")).toBe(before)
  } finally { await context.close() }
}, 60_000)

test("Codex live model list supplies capabilities and session options", async () => {
  const context = await setupConformance({ name: "codex-models", backend,
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  try {
    const capabilities = await context.transport.capabilities({ sessionId: "s1", directory: context.backend.directory })
    expect(capabilities.modelSelection.status).toBe("required")
    if (capabilities.modelSelection.status !== "required") throw new Error("Codex model selection unavailable")
    expect(capabilities.modelSelection.models.length).toBeGreaterThan(0)
    expect(capabilities.effortLevels.status).toBe("resolved")
    const { options } = await context.transport.config!.options({ session: context.session }, "probe")
    expect(options.find((option) => option.id === "model")?.selectOptions?.length).toBeGreaterThan(0)
    expect(options.some((option) => option.id === "effort")).toBe(true)
    expect(options.some((option) => option.id === "service_tier")).toBe(true)
  } finally { await context.close() }
}, 60_000)

test("Codex provider-started goal turn is admitted, streams, and settles completed", async () => {
  const context = await setupConformance({ name: "codex-goal-stream", backend,
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  let admitted!: (result: Awaited<ReturnType<typeof context.sessionBroker.admitProviderTurn>>) => void
  const admission = new Promise<Awaited<ReturnType<typeof context.sessionBroker.admitProviderTurn>>>((resolve) => { admitted = resolve })
  const original = context.sessionBroker.admitProviderTurn.bind(context.sessionBroker)
  context.sessionBroker.admitProviderTurn = async (input, run) => {
    const result = await original(input, run)
    admitted(result)
    return result
  }
  try {
    expect((await context.transport.goals!.start(context.session, "Reply with GOALSTREAM", context.sessionBroker)).ok).toBe(true)
    const result = await Promise.race([admission, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Goal turn was not admitted")), 10_000))])
    expect(result.admitted).toBe(true)
    if (!result.admitted) throw new Error("Goal turn was refused")
    expect(await result.settled).toEqual({ state: "completed" })
    expect(context.ports.drained.length).toBeGreaterThan(0)
  } finally { await context.close() }
}, 60_000)

test("Codex turn model overrides start model and validates effort and tier from model/list", async () => {
  const frames: { method?: string; params?: Record<string, unknown> }[] = []
  const context = await setupConformance({ name: "codex-model-precedence",
    backend: async () => {
      const state = await backend()
      state.configureServices = (services) => {
        const spawn = services.spawn.bind(services)
        services.spawn = async (command, options) => {
          const owned = await spawn(command, options)
          const write = owned.stdin.write.bind(owned.stdin)
          owned.stdin.write = ((chunk: string) => {
            for (const line of chunk.trim().split("\n")) frames.push(JSON.parse(line))
            return write(chunk)
          }) as typeof owned.stdin.write
          return owned
        }
      }
      return state
    },
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  try {
    const { options } = await context.transport.config!.options({ session: context.session }, "probe")
    const model = options.find((option) => option.id === "model")?.selectOptions?.[0]?.id
    expect(model).toBeDefined()
    const turn = { ...context.turn("MODEL_OVERRIDE"), model: { providerID: "codex", modelID: model! }, effort: "high",
      prompt: { ...context.turn("MODEL_OVERRIDE").prompt, serviceTier: "priority" } }
    const events = []
    for await (const event of context.transport.send(context.session, turn, context.turnBroker())) events.push(event)
    expect(events.some((event) => event.event.type === "finish")).toBe(true)
    expect(frames.find((frame) => frame.method === "thread/start")?.params?.model).toBe("gpt-4.1")
    expect(frames.find((frame) => frame.method === "turn/start")?.params).toMatchObject({ model, effort: "high", serviceTier: "priority" })
    const before = frames.filter((frame) => frame.method === "turn/start").length
    await expect((async () => { for await (const _event of context.transport.send(context.session,
      { ...turn, effort: "invalid" }, context.turnBroker())) {} })()).rejects.toThrow("does not run")
    expect(frames.filter((frame) => frame.method === "turn/start")).toHaveLength(before)
  } finally { await context.close() }
}, 60_000)

test("Codex exec approval reaches the durable broker and a denied command never runs", async () => {
  const state = await backend()
  const marker = path.join(state.root, "denied-marker")
  await fs.access(state.root, fs.constants.W_OK)
  state.server.scriptTool({ name: "exec_command", input: { cmd: `touch ${marker}`, sandbox_permissions: "require_escalated", justification: "Test a denied Codex approval" } })
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, { binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = state.origin!
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: state.credentials }
  try {
    const session = await transport.start(input, broker)
    ports.current.set("s1", { ...authority, directory: state.directory, upstreamSessionId: session.binding.upstreamSessionId })
    const turnBroker = createTurnBroker(owner, { authority: { ...authority, directory: state.directory, upstreamSessionId: session.binding.upstreamSessionId }, origin, signal: new AbortController().signal })
    const received: unknown[] = []
    const running = (async () => { for await (const event of transport.send(session, {
      turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, model: state.model,
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Run the requested command" }] }, todos: [],
    }, turnBroker)) received.push(event.event) })()
    let pending = owner.broker.list({ sessionId: "s1" }).find((item) => item.request.kind === "permission")
    for (let attempt = 0; attempt < 250 && !pending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      pending = owner.broker.list({ sessionId: "s1" }).find((item) => item.request.kind === "permission")
    }
    expect(pending?.request.kind).toBe("permission")
    if (!pending) throw new Error("Codex did not request approval")
    expect((await owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    await running
    expect(received.some((event) => (event as { type?: string }).type === "tool-start")).toBe(true)
    expect(await fs.stat(marker).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")).toBe(false)
  } finally {
    await transport.dispose()
    await state.close()
  }
}, 60_000)

test("a Codex approval whose publication fails gets the exact JSON-RPC error and its public turn still settles", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-approval-publication", backend: recorder.backend, makeTransport })
  const state = context.backend as CodexBackend
  const marker = path.join(state.root, "unpublished-marker")
  try {
    await fs.access(state.root, fs.constants.W_OK)
    state.server.scriptTool({ name: "exec_command", input: { cmd: `touch ${marker}`, sandbox_permissions: "require_escalated", justification: "Test an unpublished Codex approval" } })
    context.ports.publish = async () => { throw new Error("permission storage unavailable") }
    const events: RoutedEvent[] = []
    for await (const event of context.transport.send(context.session, context.turn("Run the requested command"), context.turnBroker())) events.push(event)
    expect(recorder.frames.filter((frame) => !frame.method && "error" in frame).map((frame) => frame.error))
      .toEqual([{ code: -32603, message: "permission storage unavailable" }])
    expect(events.filter((row) => row.event.type === "finish")).toHaveLength(1)
    expect(context.owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    expect(context.ports.saved).toHaveLength(0)
    expect(await fs.stat(marker).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")).toBe(false)
  } finally { await context.close() }
}, 60_000)

test("Codex native goals use the running app-server", async () => {
  const state = await backend()
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, {
    binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env,
  })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const owner = createRequestBroker(ports)
  const origin = state.origin!
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model,
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] }, credentials: state.credentials }
  try {
    const session = await transport.start(input, broker)
    const started = await transport.goals.start(session, "Reply with exactly this one token: CODEXGOAL", broker)
    expect(started.ok).toBe(true)
  if (started.ok && started.goal) {
      expect((await transport.goals.read(session))?.objective).toBe(started.goal.objective)
      expect((await transport.goals.pause(session)).ok).toBe(true)
      expect((await transport.goals.resume(session, broker)).ok).toBe(true)
      expect(await transport.goals.stop(session)).toMatchObject({ ok: true })
    }
  } finally {
    await transport.dispose()
    await state.close()
  }
}, 60_000)

test("brokered Codex discovers a projected plugin skill through its composed home", async () => {
  const context = await setupConformance({ name: "codex-plugin-skill", backend: async () => {
    const state = await backend()
    const plugin = path.join(state.root, "plugin")
    const skill = path.join(plugin, "skills", "conform-skill")
    await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true })
    await fs.mkdir(skill, { recursive: true })
    await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "conform-plugin", version: "1.0.0", skills: "./skills/" }))
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: conform-skill\ndescription: Conformance plugin\n---\nConformance\n")
    return { ...state, projection: { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "one", root: plugin, skillNames: [], dataRoot: plugin }] } }
  }, makeTransport })
  try {
    for await (const _event of context.transport.send(context.session, context.turn("Reply with exactly this one token: PLUGINSKILL"), context.turnBroker())) {}
    const state = context.backend as CodexBackend
    expect(JSON.stringify(state.server.requests.find((row) => row.prompt.includes("PLUGINSKILL"))?.body)).toContain("conform-skill")
  } finally { await context.close() }
}, 60_000)

test("Codex defers a projected configured MCP server's tools behind tool_search, and the loaded tool calls the server", async () => {
  const mcp = await startScriptedMcpServer()
  const context = await setupConformance({ name: "codex-projected-mcp",
    backend: async () => ({ ...(await backend()), model: { providerID: "codex", modelID: "gpt-5.5" },
      projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [{ name: "projected", kind: "http", url: mcp.url, origin: "configured" }] } }),
    makeTransport: (services, state) => new CodexAppServerTransport(services, {
      binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
    }) })
  try {
    const server = (context.backend as CodexBackend).server
    await context.transport.config!.update(context.session, { permissionMode: "full-access" })
    server.scriptTool({ name: "tool_search", format: "tool_search", input: { query: "proof" }, whenPromptIncludes: "MCPSEARCH" })
    for await (const _event of context.transport.send(context.session, context.turn("Find the proof tool MCPSEARCH"), context.turnBroker())) {}
    const [search, loaded] = server.requests.filter((request) => request.prompt.includes("MCPSEARCH") && request.tools.length)
    expect((search!.body as { tools?: { type: string }[] }).tools?.some((tool) => tool.type === "tool_search")).toBe(true)
    expect(search!.tools.map((tool) => tool.name).filter((name) => name.includes("proof"))).toEqual([])
    const proof = loaded?.tools.find((tool) => tool.call.name === "proof")
    expect(proof?.call).toEqual({ name: "proof", namespace: expect.stringMatching(/^mcp__projected/) })
    server.scriptTool({ ...proof!.call, input: { marker: "MCPCALL" }, whenPromptIncludes: "MCPCALL" })
    for await (const _event of context.transport.send(context.session, context.turn("Call the proof tool with marker MCPCALL"), context.turnBroker())) {}
    expect(mcp.calls).toEqual([{ name: "proof", arguments: { marker: "MCPCALL" } }])
    expect(server.requests.some((request) => request.prompt.includes("MCP_PROOF:MCPCALL"))).toBe(true)
  } finally {
    await context.close()
    await mcp.close()
  }
}, 60_000)

async function pendingCount(owner: ReturnType<typeof createRequestBroker>, sessionId: string, count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = owner.broker.list({ sessionId })
    if (rows.length === count) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Expected ${count} pending Codex requests for ${sessionId}`)
}

describe("Codex transport configuration", () => {
  const catalog = [
    { model: "fast", displayName: "Fast", isDefault: true, defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
    { model: "deep", displayName: "Deep", defaultReasoningEffort: "high", hidden: true,
      supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
  ]
  async function configuredCodex() {
    const peer = await scriptedTransport({ models: catalog, completeTurns: true })
    const turn = (model?: string, effort?: string, serviceTier?: string | null): TurnInput => ({
      turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", todos: [],
      origin: { actor: peer.startInput.owner, via: "loopback", reissued: false },
      ...(model ? { model: { providerID: "codex", modelID: model } } : {}), ...(effort ? { effort } : {}),
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }], serviceTier: serviceTier ?? undefined },
    })
    const run = async (session: Awaited<ReturnType<typeof peer.transport.start>>, value: TurnInput) => {
      for await (const _event of peer.transport.send(session, value, { signal: new AbortController().signal } as TurnBroker)) {}
    }
    return Object.assign(peer, { turn, run })
  }

  test.each(["default", "deep"])("thread creation preserves the native model selection %s", async (modelID) => {
    const f = await configuredCodex()
    try {
      await f.transport.start({ ...f.startInput, model: { providerID: "codex", modelID } }, f.liveBroker())
      expect(f.frames.find((row) => row.method === "thread/start")?.params?.model).toBe(modelID === "default" ? undefined : modelID)
    } finally { await f.close() }
  })

  test("a cold first turn sends its explicit model effort and priority tier", async () => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start({ ...f.startInput, model: { providerID: "codex", modelID: "deep" } }, f.liveBroker())
      await f.run(session, f.turn("fast", "high", "priority"))
      expect(f.frames.filter((row) => row.method === "model/list")).toHaveLength(1)
      expect(f.frames.find((row) => row.method === "turn/start")?.params).toMatchObject({ model: "fast", effort: "high", serviceTier: "priority" })
    } finally { await f.close() }
  })

  test("every turn sends concrete defaults after an explicit model effort and tier", async () => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start(f.startInput, f.liveBroker())
      await f.run(session, f.turn("deep", "xhigh", "priority"))
      await f.run(session, f.turn())
      expect(f.frames.filter((row) => row.method === "turn/start").map((row) => ({ model: row.params?.model, effort: row.params?.effort, serviceTier: row.params?.serviceTier })))
        .toEqual([{ model: "deep", effort: "xhigh", serviceTier: null }, { model: "fast", effort: "low", serviceTier: null }])
    } finally { await f.close() }
  })

  test("options describe the requested model independently of the last created session", async () => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start({ ...f.startInput, model: { providerID: "codex", modelID: "deep" } }, f.liveBroker())
      const options = async (modelID: string) => (await f.transport.config.options({ session, model: { providerID: "codex", modelID } }, "probe")).options
      const fast = await options("fast")
      const deep = await options("deep")
      expect(fast.find((row) => row.id === "effort")?.selectOptions?.map((row) => row.id)).toEqual(["low", "high"])
      expect(deep.find((row) => row.id === "effort")?.selectOptions?.map((row) => row.id)).toEqual(["high", "xhigh"])
      expect(fast.find((row) => row.id === "service_tier")?.selectOptions).toEqual([{ id: "priority", name: "Fast" }])
      expect(deep.find((row) => row.id === "service_tier")).toBeUndefined()
      expect((await options("fast"))).toEqual(fast)
    } finally { await f.close() }
  })

  test("a hidden model is confirmed before its turn and an unsupported effort never starts", async () => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start(f.startInput, f.liveBroker())
      await expect(f.run(session, f.turn("deep", "low"))).rejects.toMatchObject({ code: "configuration" })
      expect(f.frames.filter((row) => row.method === "turn/start")).toHaveLength(0)
      await f.run(session, f.turn("deep", "xhigh"))
      expect(f.frames.find((row) => row.method === "turn/start")?.params).toMatchObject({ model: "deep", effort: "xhigh" })
    } finally { await f.close() }
  })

  test.each(["priority", null, "flex"])("a requested service tier %p reaches the wire with its canonical value", async (tier) => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start(f.startInput, f.liveBroker())
      await f.run(session, f.turn("fast", "high", tier))
      expect(f.frames.find((row) => row.method === "turn/start")?.params?.serviceTier).toBe(tier === "priority" ? "priority" : null)
    } finally { await f.close() }
  })

  test("the selected openai Codex account is brokered", async () => {
    const f = await configuredCodex()
    try {
      await fs.mkdir(path.join(f.root, "owner"))
      await fs.writeFile(path.join(f.root, "owner", "auth.json"), '{"tokens":{"access_token":"operator-sentinel"}}')
      await f.transport.start({ ...f.startInput, credentials: { ...f.startInput.credentials, providers: {
        openai: { baseUrl: "http://127.0.0.1:48850/binding", placeholder: "signed-placeholder", authMode: "bearer", apiPath: "/backend-api/codex" },
      } } }, f.liveBroker())
      const home = f.environments[0]!.CODEX_HOME!
      const config = await fs.readFile(path.join(home, "config.toml"), "utf8")
      const entries = await fs.readdir(home)
      expect(config).toContain('base_url = "http://127.0.0.1:48850/binding/backend-api/codex"')
      expect(config).toContain('Authorization = "Bearer signed-placeholder"')
      expect(config).toContain('requires_openai_auth = false')
      expect(config).toContain('wire_api = "responses"')
      expect(config).not.toContain("operator-sentinel")
      expect(entries).not.toContain("auth.json")
      expect(f.frames.find((row) => row.method === "thread/start")?.params?.modelProvider).toBe("broker")
      expect(f.frames.some((row) => row.method === "account/login/start")).toBe(false)
    } finally { await f.close() }
  })

  test.skipIf(process.platform === "win32")("Codex narrows a permissive composed home on the next launch", async () => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start(f.startInput, f.liveBroker())
      const home = f.environments[0]!.CODEX_HOME!
      await f.transport.close(session)
      await fs.chmod(home, 0o755)
      await f.transport.start(f.startInput, f.liveBroker())
      expect((await fs.stat(home)).mode & 0o777).toBe(0o700)
    } finally { await f.close() }
  })

  test("Codex refuses a symlinked composed home before spawning", async () => {
    const f = await configuredCodex()
    try {
      const session = await f.transport.start(f.startInput, f.liveBroker())
      const home = f.environments[0]!.CODEX_HOME!
      await f.transport.close(session)
      await fs.rename(home, `${home}-outside`)
      const before = await fs.readFile(path.join(`${home}-outside`, "config.toml"), "utf8")
      await fs.symlink(`${home}-outside`, home, process.platform === "win32" ? "junction" : "dir")
      await expect(f.transport.start(f.startInput, f.liveBroker())).rejects.toThrow("symlink")
      expect(f.environments).toHaveLength(1)
      expect(await fs.readFile(path.join(`${home}-outside`, "config.toml"), "utf8")).toBe(before)
    } finally { await f.close() }
  })

  test("closing an unattached Codex session never starts the broken executable", async () => {
    const f = await configuredCodex()
    try {
      await f.transport.close({ directory: f.startInput.directory, locality: "local", binding: await f.liveBroker().rebind("missing-thread") })
      expect(f.environments).toHaveLength(0)
      expect(f.frames).toHaveLength(0)
    } finally { await f.close() }
  })

})

describe("Codex request persistence", () => {
  const interactions = [
    { name: "command approval", method: "item/commandExecution/requestApproval", params: { command: "echo test" },
      answer: { kind: "permission", decision: "deny" }, result: { decision: "decline" } },
    { name: "question", method: "item/tool/requestUserInput", params: { questions: [{ id: "q", question: "Choose?" }] },
      answer: { kind: "answers", answers: [["Staging"]] }, result: { answers: { q: { answers: ["Staging"] } } } },
    { name: "MCP form", method: "mcpServer/elicitation/request", params: { mode: "form", message: "Input", requestedSchema: { type: "object", properties: {} } },
      answer: { kind: "form", values: {} }, result: { action: "accept", content: {} } },
    { name: "MCP approval", method: "mcpServer/elicitation/request", params: { mode: "form", serverName: "test", message: "Allow tool?",
      requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call" } },
      answer: { kind: "permission", decision: "deny", optionId: "cancel" }, result: { action: "cancel", content: null, _meta: null } },
  ] satisfies { name: string; method: string; params: Record<string, unknown>; answer: RequestAnswer; result: unknown }[]

  for (const interaction of interactions) {
    test(`${interaction.name} accepts a reply initiated during publication and leaves no pending request`, async () => {
      const ports = new MemoryPorts()
      const owner = createRequestBroker(ports)
      let response: Promise<unknown> | undefined
      ports.publish = async (event, pending) => {
        await MemoryPorts.prototype.publish.call(ports, event, pending)
        if (!pending) return
        expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
        response = owner.broker.answer(pending.request.requestId, interaction.answer, { sessionId: "s1" })
      }
      const broker = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
      expect(await answerCodexRequest({ id: 0, method: interaction.method, params: interaction.params }, broker, "s1"))
        .toEqual(interaction.result)
      expect(await response).toMatchObject({ ok: true })
      expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
      expect(ports.saved).toHaveLength(1)
    })

    test(`${interaction.name} removes its pending request when publication fails`, async () => {
      const ports = new MemoryPorts()
      const owner = createRequestBroker(ports)
      ports.publish = async () => {
        expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
        throw new Error("permission storage failed")
      }
      const broker = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
      await expect(answerCodexRequest({ id: 0, method: interaction.method, params: interaction.params }, broker, "s1"))
        .rejects.toThrow("permission storage failed")
      expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
      expect(ports.saved).toHaveLength(0)
    })
  }

  test("a failed durable Codex grant write withholds approval until cancellation", async () => {
    const ports = new MemoryPorts()
    ports.failGrant = true
    const owner = createRequestBroker(ports)
    const broker = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    let released = false
    const asking = answerCodexRequest({ id: 0, method: "item/commandExecution/requestApproval", params: { command: "echo test" } }, broker, "s1")
      .then((answer) => { released = true; return answer })
    await pendingCount(owner, "s1", 1)
    const pending = owner.broker.list({ sessionId: "s1" })[0]!
    expect(await owner.broker.answer(pending.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" }))
      .toMatchObject({ ok: false, refusal: "persistence" })
    expect(released).toBe(false)
    expect(ports.saved).toHaveLength(0)
    expect(ports.states.size).toBe(0)
    await owner.endTurn(authority)
    expect(await asking).toEqual({ decision: "cancel" })
  })

  const grantCommand = { command: "printf approved > /tmp/result", cwd: "/work", additionalPermissions: null }
  function codexGrants() {
    const ports = new MemoryPorts()
    let owner = createRequestBroker(ports)
    let count = 0
    let decision: PermissionDecision = "deny"
    ports.publish = async (event, pending) => {
      await MemoryPorts.prototype.publish.call(ports, event, pending)
      if (!pending) return
      count++
      void owner.broker.answer(pending.request.requestId, { kind: "permission", decision }, { sessionId: pending.sessionId })
    }
    const run = async (answer: PermissionDecision, sessionId = "s1", params: Record<string, unknown> = grantCommand, mode = "workspace-write", directory = "/work") => {
      decision = answer
      const current = { ...authority, sessionId, workspaceId: sessionId === "s1" ? "w1" : "w2", directory, upstreamSessionId: `process-${count}`, turnId: `turn-${count}` }
      ports.current.set(sessionId, current)
      ports.directories.set(sessionId, directory)
      owner = createRequestBroker(ports)
      const broker = createTurnBroker(owner, { authority: current, origin, signal: new AbortController().signal })
      return answerCodexRequest({ id: 0, method: "item/commandExecution/requestApproval", params: {
        ...params, threadId: current.upstreamSessionId, turnId: current.turnId, itemId: `item-${count}`, startedAtMs: count,
      } }, broker, sessionId, { directory, permissionMode: mode })
    }
    return { ports, run, count: () => count }
  }

  test.each(["allow_always", "allow_once", "deny", "reject_always"] as const)("Codex %s is reused after broker reconstruction only when it was allow_always", async (decision) => {
    const f = codexGrants()
    expect(await f.run(decision)).toEqual({ decision: { allow_always: "acceptForSession", allow_once: "accept", deny: "decline", reject_always: "decline" }[decision] })
    expect(f.count()).toBe(1)
    expect(await f.run("deny")).toEqual({ decision: decision === "allow_always" ? "acceptForSession" : "decline" })
    expect(f.count()).toBe(decision === "allow_always" ? 1 : 2)
  })

  test("a saved Codex allow_always grant stores a digest and none of the approved request", async () => {
    const f = codexGrants()
    await f.run("allow_always", "s1", { ...grantCommand, command: "printf APPROVED-COMMAND > /tmp/result" })
    const grants = f.ports.states.get("s1")?.brokerGrants
    expect(Array.isArray(grants) ? grants.map((grant) => JSON.parse(String(grant))) : grants).toEqual([["c1", expect.stringMatching(/^[0-9a-f]{64}$/)]])
    expect(JSON.stringify([f.ports.states.get("s1"), f.ports.published.filter((event) => event.type === "permission.auto-answered")])).not.toContain("APPROVED")
  })

  test.each([
    ["the session is in another workspace", "other", grantCommand, "workspace-write", "/work"],
    ["the command changes", "s1", { ...grantCommand, command: "rm /tmp/result" }, "workspace-write", "/work"],
    ["the native cwd changes", "s1", { ...grantCommand, cwd: "/other" }, "workspace-write", "/work"],
    ["the permission mode changes", "s1", grantCommand, "plan", "/work"],
    ["an unknown native field appears", "s1", { ...grantCommand, futurePermissionContext: "new-authority" }, "workspace-write", "/work"],
    ["the workspace directory changes", "s1", grantCommand, "workspace-write", "/other"],
    ["additional permissions are requested", "s1", { ...grantCommand, additionalPermissions: { network: { enabled: true } } }, "workspace-write", "/work"],
  ] satisfies [string, string, Record<string, unknown>, string, string][])("a saved Codex allow_always grant asks again when %s", async (_name, sessionId, params, mode, directory) => {
    const f = codexGrants()
    await f.run("allow_always")
    expect(await f.run("deny", sessionId, params, mode, directory)).toEqual({ decision: "decline" })
    expect(f.count()).toBe(2)
  })

  const approvalFrame = { id: 0, method: "item/commandExecution/requestApproval", params: { command: "echo test" } }
  const questionFrame = { id: 0, method: "item/tool/requestUserInput", params: { questions: [{ id: "environment", question: "Which environment?" }] } }
  const staging = { answers: { environment: { answers: ["Staging"] } } }
  test.each([
    ["an approval", approvalFrame, [{ kind: "permission", decision: "allow_once" }, { kind: "permission", decision: "deny" }], [{ decision: "accept" }, { decision: "decline" }]],
    ["an answered question", questionFrame, [{ kind: "answers", answers: [["Staging"]] }, { kind: "answers", answers: [["Production"]] }],
      [staging, { answers: { environment: { answers: ["Production"] } } }]],
    ["a dismissed question", questionFrame, [{ kind: "answers", answers: [["Staging"]] }, { kind: "rejected" }], [staging, { answers: {} }]],
  ] satisfies [string, RpcMessage, RequestAnswer[], unknown[]][])("RPC id zero in two workspaces keeps native identity and routes %s to its own session", async (_name, frame, answers, results) => {
    const ports = new MemoryPorts()
    const owner = createRequestBroker(ports)
    const replies = ["s1", "s2"].map((sessionId) => {
      const current = { ...authority, sessionId, workspaceId: sessionId === "s1" ? "w1" : "w2" }
      ports.current.set(sessionId, current)
      ports.directories.set(sessionId, "/work")
      return answerCodexRequest(frame, createTurnBroker(owner, { authority: current, origin, signal: new AbortController().signal }), sessionId)
    })
    const [first] = await pendingCount(owner, "s1", 1)
    const [second] = await pendingCount(owner, "s2", 1)
    expect(first!.request.requestId).not.toBe(second!.request.requestId)
    const native = (row: PendingRequest) => row.request.kind === "question" ? row.request.question.harnessPayload
      : row.request.kind === "permission" ? row.request.permission.harnessPayload : undefined
    expect([native(first!), native(second!)]).toEqual([frame, frame])
    expect(await owner.broker.answer(second!.request.requestId, answers[0]!, { sessionId: "s1" })).toMatchObject({ ok: false, refusal: "foreign" })
    expect(owner.broker.list({ sessionId: "s2" })).toEqual([second!])
    for (const [index, row] of [first!, second!].entries()) {
      expect(await owner.broker.answer(row.request.requestId, answers[index]!, { sessionId: row.sessionId })).toMatchObject({ ok: true })
    }
    expect(await Promise.all(replies)).toEqual(results)
    expect(owner.broker.list({ directory: "/work" })).toHaveLength(0)
  })

})
