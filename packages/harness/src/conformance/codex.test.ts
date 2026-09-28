import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"
import { runConformance, setupConformance, type ConformanceBackend, withUndeliverableFile } from "./test-support/run"
import { SESSION_TITLE_SYSTEM_PROMPT } from "../../e2e/harness/config"
import { ensurePinnedCodex, PINNED_CODEX } from "../../e2e/harness/pinned-codex"
import { reservePort, releasePort } from "../../e2e/harness/ports"
import { listenOnLoopback } from "../../e2e/harness/ports"
import { startScriptedModelServer } from "../../e2e/harness/scripted-model-server"
import { egressProxyEnv, startEgressGuard, unexpectedEgress } from "../../e2e/harness/egress-guard"
import { CodexAppServerTransport } from "../transports/codex-app-server"
import { CodexRpc } from "../transports/codex-app-server/rpc"
import { answerCodexRequest } from "../transports/codex-app-server/requests"
import { prepareCodexProfile } from "../profiles/codex"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../broker"
import { MemoryPorts, authority, origin } from "./test-support/memory-ports"
import { createTestServices } from "./test-support/services"
import type { HarnessTransport, StartInput, TurnInput } from "../contract"

type CodexBackend = ConformanceBackend & {
  root: string
  env: NodeJS.ProcessEnv
  server: Awaited<ReturnType<typeof startScriptedModelServer>>
}

async function backend(): Promise<CodexBackend> {
  await ensurePinnedCodex()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-conformance-"))
  const directory = path.join(root, "work")
  await fs.mkdir(directory)
  await fs.writeFile(path.join(directory, "conformance.txt"), "conformance tool result\n")
  const modelPort = await reservePort()
  const guardPort = await reservePort()
  const server = await startScriptedModelServer({ port: modelPort, red: false })
  const guard = await startEgressGuard(guardPort)
  return {
    root, directory, server, env: { ...process.env, ...egressProxyEnv(guard.url) },
    harness: { id: "codex", access: "native" }, expectedMcp: "config",
    model: { providerID: "codex", modelID: "gpt-4.1" },
    credentials: { machineLoginAllowed: false, accountOwner: "fixture-owner", providers: { openai: { baseUrl: server.v1Url, placeholder: "codex-conformance-placeholder", authMode: "api-key" } },
      secrets: {}, leaseGeneration: "conformance" },
    owner: { kind: "person", userId: "member" },
    origin: { actor: { kind: "person", userId: "member" }, via: "relay", reissued: false },
    hold: (marker) => server.holdTextReplies(marker),
    held: (marker) => server.textGateReached(marker),
    unrunnableTurn: withUndeliverableFile,
    cleanupWithoutCommands: "verified_clear",
    close: async () => {
      console.log(`Codex outbound attempts: ${JSON.stringify(guard.attempts)}`)
      const unexpected = unexpectedEgress(guard.attempts)
      await guard.close()
      await server.close()
      releasePort(modelPort)
      releasePort(guardPort)
      await fs.rm(root, { recursive: true, force: true })
      expect(unexpected).toEqual([])
    },
  }
}

type Frame = { id?: number; method?: string; params?: Record<string, unknown> }

function recordingBackend(): { backend: () => Promise<CodexBackend>; frames: Frame[] } {
  const frames: Frame[] = []
  return { frames, backend: async () => {
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
  } }
}

function makeTransport(services: Parameters<Parameters<typeof runConformance>[0]["makeTransport"]>[0], state: ConformanceBackend) {
  return new CodexAppServerTransport(services, {
    binary: PINNED_CODEX, homeRoot: path.join((state as CodexBackend).root, "homes"), env: (state as CodexBackend).env,
  })
}

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
    const attached = await context.transport.attach({ ...context.start, config: { ...context.start.config, permissionMode: "read-only" }, binding: context.session.binding }, context.sessionBroker)
    expect(recorder.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ approvalPolicy: "never", sandbox: "read-only" })
    await context.transport.close(attached)
  } finally { await context.close() }
}, 90_000)

test("Codex spawn_agent runs a child thread whose events route to the child session", async () => {
  const recorder = recordingBackend()
  const context = await setupConformance({ name: "codex-subagent", backend: recorder.backend, makeTransport })
  try {
    const state = context.backend as CodexBackend
    state.server.scriptTool({ name: "spawn_agent", input: { task_name: "child_inspect", message: "Inspect the workspace for CODEXCHILDTASK" },
      whenPromptIncludes: "CODEXPARENT" })
    state.server.scriptText({ marker: "CODEXCHILDTASK", text: "CODEXCHILD" })
    const events = []
    for await (const event of context.transport.send(context.session,
      context.turn("Delegate one child task, then reply with exactly this one token: CODEXPARENT"), context.turnBroker())) events.push(event)
    const childText = events.filter((item) => item.event.type === "text-delta" && item.event.delta.includes("CODEXCHILD"))
    expect(childText.length).toBeGreaterThan(0)
    expect(childText.every((item) => item.route?.kind === "child")).toBe(true)
    expect(events.some((item) => item.route?.kind !== "child" && item.event.type === "text-delta" && item.event.delta.includes("CODEXPARENT"))).toBe(true)
    expect(events.filter((item) => item.route?.kind !== "child" && item.event.type === "finish")).toHaveLength(1)
    expect(context.ports.subagents.some((row) => row.status === "running" && row.toolCallId && row.childSessionId)).toBe(true)
    expect(context.ports.subagents.some((row) => row.status === "completed")).toBe(true)
    const started = recorder.frames.filter((frame) => frame.method === "thread/start")
    expect(started[0]?.params?.dynamicTools).toBeDefined()
    expect(started[1]?.params).toMatchObject({ threadSource: "subagent", sandbox: "workspace-write" })
    expect(recorder.frames.filter((frame) => frame.method === "turn/start")).toHaveLength(2)
    expect((await context.transport.capabilities({ directory: context.backend.directory })).subagents).toBe(true)
  } finally { await context.close() }
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

const OWNER_KEY = "owner-key-1"

async function ownLoginContext(name: string) {
  const state = await backend()
  const ownerHome = path.join(state.root, "owner-codex")
  const mcpPort = await reservePort()
  const mcpRequests: string[] = []
  const mcp = createServer((request, response) => { mcpRequests.push(request.url ?? ""); response.writeHead(404).end() })
  await listenOnLoopback(mcp, mcpPort)
  await fs.mkdir(path.join(ownerHome, "skills", "owner-skill"), { recursive: true })
  await fs.writeFile(path.join(ownerHome, "skills", "owner-skill", "SKILL.md"), "---\nname: owner-skill\ndescription: Owner skill\n---\nOwner\n")
  await fs.writeFile(path.join(ownerHome, "AGENTS.md"), "Owner instructions\n")
  await fs.writeFile(path.join(ownerHome, "auth.json"), `${JSON.stringify({ OPENAI_API_KEY: OWNER_KEY })}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(ownerHome, "config.toml"), [
    'model = "gpt-4.1"', 'model_provider = "owner-scripted"', "check_for_update_on_startup = false", "",
    "[model_providers.owner-scripted]", 'name = "Owner scripted provider"', `base_url = ${JSON.stringify(state.server.v1Url)}`,
    'wire_api = "responses"', "requires_openai_auth = true", "", "[mcp_servers.owner]",
    `url = ${JSON.stringify(`http:${String.fromCharCode(47, 47)}127.0.0.1:${mcpPort}/mcp`)}`, "",
  ].join("\n"))
  const ownLogin: CodexBackend = { ...state, owner: { kind: "machine-owner" }, credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "own" },
    close: async () => {
      mcp.closeAllConnections()
      await new Promise<void>((resolve) => mcp.close(() => resolve()))
      releasePort(mcpPort)
      await state.close()
    } }
  const context = await setupConformance({ name, backend: async () => ownLogin, makeTransport: (services, backendState) => new CodexAppServerTransport(services, {
    binary: PINNED_CODEX, homeRoot: path.join((backendState as CodexBackend).root, "homes"), env: (backendState as CodexBackend).env, ownerHome,
  }) })
  return { context, ownerHome, mcpRequests, homes: path.join(state.root, "homes") }
}

async function hashes(root: string): Promise<Record<string, string>> {
  const rows: Record<string, string> = {}
  const walk = async (folder: string) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else rows[path.relative(root, file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex")
    }
  }
  await walk(root)
  return rows
}

function entryHome(transport: HarnessTransport, sessionId: string): string {
  return (transport as unknown as { entries: Map<string, { home: string }> }).entries.get(sessionId)!.home
}

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
    const firstAgain = await context.transport.attach({ ...context.start, binding: first.binding }, context.sessionBroker)
    const secondAgain = await context.transport.attach({ ...secondStart, binding: second.binding }, secondBroker)
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
    const rpc = (context.transport as unknown as { entries: Map<string, { rpc: CodexRpc }> }).entries.get("s1")!.rpc
    expect(await rpc.request("account/login/start", { type: "apiKey", apiKey: "owner-key-2" })).toEqual({ type: "apiKey" })
    expect(await fs.readFile(path.join(ownerHome, "auth.json"), "utf8")).toContain("owner-key-2")
    expect((await fs.lstat(path.join(home, "auth.json"))).isSymbolicLink()).toBe(true)
    const { "auth.json": _after, ...after } = await hashes(ownerHome)
    expect(after).toEqual(before)
    const stray = (await fs.readdir(home, { recursive: true })).filter((name) => name.endsWith("auth.json") && name !== "auth.json")
    expect(stray).toEqual([])
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
  const marker = `/etc/codex-denied-${process.pid}-${Date.now()}`
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
  const state = await backend()
  const plugin = path.join(state.root, "plugin")
  const skill = path.join(plugin, "skills", "conform-skill")
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true })
  await fs.mkdir(skill, { recursive: true })
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "conform-plugin", version: "1.0.0", skills: "./skills/" }))
  await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: conform-skill\ndescription: Conformance plugin\n---\nConformance\n")
  const projection = { generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "one", root: plugin, skillNames: [], dataRoot: plugin }] }
  const services = createTestServices()
  let rpc: CodexRpc | undefined
  try {
    const { home } = await prepareCodexProfile({ homeRoot: path.join(state.root, "homes"), owner: state.owner, credentials: state.credentials, projection })
    const owned = await services.spawn({ file: PINNED_CODEX, args: ["app-server", "--listen", "stdio://"], cwd: state.directory,
      env: { ...state.env, CODEX_HOME: home } as Record<string, string> }, { role: "harness", label: "Codex plugin conformance", signal: new AbortController().signal })
    rpc = new CodexRpc(owned, services.clock)
    await rpc.request("initialize", { clientInfo: { name: "claxedo", version: "0.1.0" }, capabilities: { experimentalApi: true } })
    rpc.notify("initialized")
    const response = await rpc.request("skills/list", { cwds: [state.directory], forceReload: true })
    expect(JSON.stringify(response)).toContain("conform-skill")
  } finally {
    if (rpc) await rpc.retire({ at: Date.now() + 10_000, signal: new AbortController().signal })
    await state.close()
  }
}, 60_000)

test("Codex starts a projected configured MCP server", async () => {
  const state = await backend()
  const port = await reservePort()
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.writeHead(404).end()
  })
  await listenOnLoopback(server, port)
  const services = createTestServices()
  const transport = new CodexAppServerTransport(services, { binary: PINNED_CODEX, homeRoot: path.join(state.root, "homes"), env: state.env })
  const ports = new MemoryPorts()
  ports.current.set("s1", { ...authority, directory: state.directory })
  const origin = state.origin!
  const owner = createRequestBroker(ports)
  const broker = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: state.directory, origin })
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: state.directory, locality: "local", owner: state.owner,
    config: { harness: state.harness, model: state.model }, model: state.model, credentials: state.credentials,
    projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [
      { name: "projected", kind: "http", url: `http:${String.fromCharCode(47, 47)}127.0.0.1:${port}/mcp`, origin: "configured" },
    ] } }
  try {
    await transport.start(input, broker)
    expect(requests.length).toBeGreaterThan(0)
  } finally {
    await transport.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    releasePort(port)
    await state.close()
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

test("Codex native request IDs are unique across processes and answers stay in their sessions", async () => {
  const ports = new MemoryPorts()
  ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
  ports.directories.set("s2", "/work")
  const owner = createRequestBroker(ports)
  const first = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  const second = createTurnBroker(owner, { authority: { ...authority, sessionId: "s2", workspaceId: "w2" }, origin,
    signal: new AbortController().signal })
  const question = { id: 0, method: "item/tool/requestUserInput", params: { questions: [{ id: "answer", question: "Choose" }] } }
  const one = answerCodexRequest(question, first, "s1")
  const two = answerCodexRequest(question, second, "s2")
  const [row1] = await pendingCount(owner, "s1", 1)
  const [row2] = await pendingCount(owner, "s2", 1)
  expect(row1?.request.requestId).not.toBe(row2?.request.requestId)
  expect((await owner.broker.answer(row1!.request.requestId, { kind: "answers", answers: [["one"]] }, { sessionId: "s1" })).ok).toBe(true)
  expect((await owner.broker.answer(row2!.request.requestId, { kind: "answers", answers: [["two"]] }, { sessionId: "s2" })).ok).toBe(true)
  expect(await one).toEqual({ answers: { answer: { answers: ["one"] } } })
  expect(await two).toEqual({ answers: { answer: { answers: ["two"] } } })
})

test("Codex persistent approval grants reapply only to the same session, directory, mode, and command", async () => {
  const ports = new MemoryPorts()
  const owner = createRequestBroker(ports)
  const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
  const context = { directory: "/work", permissionMode: "default" }
  const command = { id: 0, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1, command: "echo hello", cwd: "/work",
  } }
  const first = answerCodexRequest(command, turn, "s1", context)
  const [pending] = await pendingCount(owner, "s1", 1)
  expect((await owner.broker.answer(pending!.request.requestId, { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).ok).toBe(true)
  expect(await first).toEqual({ decision: "acceptForSession" })
  ports.current.set("s1", { ...authority, turnId: "replacement-turn" })
  const replacement = createTurnBroker(owner, { authority: { ...authority, turnId: "replacement-turn" }, origin,
    signal: new AbortController().signal })
  const same = { ...command, params: { ...command.params, turnId: "new-turn", itemId: "new-item" } }
  expect(await answerCodexRequest(same, replacement, "s1", context)).toEqual({ decision: "acceptForSession" })
  const variants = [
    { frame: { ...same, params: { ...same.params, command: "echo changed" } }, context },
    { frame: same, context: { ...context, directory: "/other" } },
    { frame: same, context: { ...context, permissionMode: "restricted" } },
    { frame: { ...same, params: { ...same.params, additionalPermissions: ["network"] } }, context },
  ]
  for (const variant of variants) {
    const asked = answerCodexRequest(variant.frame, replacement, "s1", variant.context)
    const [row] = await pendingCount(owner, "s1", 1)
    expect((await owner.broker.answer(row!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    expect(await asked).toEqual({ decision: "decline" })
  }
  ports.current.set("s2", { ...authority, sessionId: "s2", workspaceId: "w2" })
  ports.directories.set("s2", "/work")
  const foreign = createTurnBroker(owner, { authority: { ...authority, sessionId: "s2", workspaceId: "w2" }, origin,
    signal: new AbortController().signal })
  const otherSession = answerCodexRequest(same, foreign, "s2", context)
  const [other] = await pendingCount(owner, "s2", 1)
  expect((await owner.broker.answer(other!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s2" })).ok).toBe(true)
  expect(await otherSession).toEqual({ decision: "decline" })
  for (const decision of ["allow_once", "deny", "reject_always"] as const) {
    const frame = { ...same, params: { ...same.params, command: `echo ${decision}` } }
    const asked = answerCodexRequest(frame, replacement, "s1", context)
    const [row] = await pendingCount(owner, "s1", 1)
    expect((await owner.broker.answer(row!.request.requestId, { kind: "permission", decision }, { sessionId: "s1" })).ok).toBe(true)
    await asked
    const retry = answerCodexRequest({ ...frame, params: { ...frame.params, turnId: `after-${decision}` } }, replacement, "s1", context)
    const [again] = await pendingCount(owner, "s1", 1)
    expect((await owner.broker.answer(again!.request.requestId, { kind: "permission", decision: "deny" }, { sessionId: "s1" })).ok).toBe(true)
    expect(await retry).toEqual({ decision: "decline" })
  }
})
