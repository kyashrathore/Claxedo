import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { Clock, DraftLaunch, HarnessServices, OwnedProcess, SessionBroker, StartInput, TurnBroker, TurnInput } from "../../contract"
import { projectCodexThreadConfig } from "./configuration"
import { CodexAppServerTransport } from "."

const input: StartInput = {
  workspaceId: "w1",
  sessionId: "s1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" },
  config: { harness: { id: "codex", access: "native" } },
  projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [
    { kind: "stdio", name: "configured", command: "server", args: ["--port", "47501"], env: { TOKEN: "sentinel" }, origin: "configured" },
    { kind: "http", name: "plugin", url: "http://127.0.0.1:47502", headers: { Authorization: "Bearer sentinel" }, origin: "plugin" },
  ] },
  credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" },
}

function rebindTo(directory: string) {
  return async (upstreamSessionId: string) => Object.freeze({ sessionId: "s1", workspaceId: "w1", directory, connectionId: "codex-app-server", upstreamSessionId })
}

test("Codex receives every projected MCP server and local first-party server", () => {
  const services = { firstPartyMcp: () => ({ kind: "http", name: "claxedo", url: "http://127.0.0.1:47503" }) } as unknown as HarnessServices
  const config = projectCodexThreadConfig(input, services)
  expect(config.mcp_servers).toEqual({
    configured: { command: "server", args: ["--port", "47501"], env: { TOKEN: "sentinel" } },
    plugin: { url: "http://127.0.0.1:47502", http_headers: { Authorization: "Bearer sentinel" } },
    claxedo: { url: "http://127.0.0.1:47503", http_headers: {} },
  })
  expect((projectCodexThreadConfig({ ...input, locality: "remote" }, services).mcp_servers as Record<string, unknown>).claxedo).toBeUndefined()
})

test("disposing during pending initialize retires the process before start rejects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-initialize-"))
  const stdin = new PassThrough()
  let exit!: (value: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
  let retired = false
  const process: OwnedProcess = { pid: 5_000_000, stdin, stdout: new PassThrough(), stderr: new PassThrough(), exited,
    retire: async () => { retired = true; exit({ code: 0, signal: null }); return { stopped: true } } }
  const services = { spawn: async () => process, recordHomeUse: async () => {},
    clock: { now: Date.now, setTimeout, clearTimeout } } as unknown as HarnessServices
  const transport = new CodexAppServerTransport(services, { binary: "unused", homeRoot: root })
  let initialized!: () => void
  const sent = new Promise<void>((resolve) => { initialized = resolve })
  stdin.on("data", (chunk) => { if (String(chunk).includes('"initialize"')) initialized() })
  const starting = transport.start({ ...input, projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [] } },
    {} as SessionBroker)
  try {
    await sent
    await transport.dispose()
    await expect(starting).rejects.toThrow()
    expect(retired).toBe(true)
    expect(await exited).toEqual({ code: 0, signal: null })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

type Frame = { id?: number; method?: string; params?: Record<string, unknown> }

async function scriptedTransport(options: { holdTurnStart?: boolean; clock?: Clock } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-scripted-"))
  const frames: Frame[] = []
  const processes: { stdout: PassThrough; exit: (value: { code: number | null; signal: string | null }) => void }[] = []
  let turnStarted!: () => void
  const started = new Promise<void>((resolve) => { turnStarted = resolve })
  let retired = 0
  let heldTurnStart: number | undefined
  const spawn = async (): Promise<OwnedProcess> => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let exit!: (value: { code: number | null; signal: string | null }) => void
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
    processes.push({ stdout, exit })
    stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        const frame = JSON.parse(line) as Frame
        frames.push(frame)
        if (frame.id === undefined) continue
        if (frame.method === "turn/start" && options.holdTurnStart) { heldTurnStart = frame.id; turnStarted(); continue }
        const result = frame.method === "thread/start" ? { thread: { id: "thread-1" } }
          : frame.method === "model/list" ? { data: [{ model: "test-model", isDefault: true }] }
            : frame.method === "turn/start" ? { turn: { id: "turn-current" } } : {}
        stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
        if (frame.method === "turn/start") turnStarted()
      }
    })
    return { pid: 5_000_002 + processes.length, stdin, stdout, stderr: new PassThrough(), exited,
      retire: async () => { retired++; exit({ code: 0, signal: null }); return { stopped: true } } }
  }
  const services = { spawn, recordHomeUse: async () => {}, firstPartyMcp: () => undefined,
    clock: options.clock ?? { now: Date.now, setTimeout, clearTimeout } } as unknown as HarnessServices
  const transport = new CodexAppServerTransport(services, { binary: "unused", homeRoot: path.join(root, "homes"), ownerHome: path.join(root, "owner") })
  const startInput = { ...input, directory: root, projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [] } }
  const close = async () => { await transport.dispose(); await fs.rm(root, { recursive: true, force: true }) }
  const releaseTurnStart = () => {
    if (heldTurnStart === undefined) throw new Error("No held turn/start")
    processes.at(-1)!.stdout.write(`${JSON.stringify({ id: heldTurnStart, result: { turn: { id: "turn-current" } } })}\n`)
  }
  const liveBroker = () => ({ rebind: rebindTo(root), goal: { publish: async () => {} }, reportFailure: () => {} } as unknown as SessionBroker)
  return { transport, startInput, started, frames, releaseTurnStart, liveBroker, retired: () => retired,
    get stdout() { return processes.at(-1)!.stdout }, spawned: () => processes.length, exitLatest: () => processes.at(-1)!.exit({ code: 1, signal: null }), close }
}

const turnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
  prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Reply" }] }, todos: [] } as TurnInput

test("Codex refuses the external-auth token refresh request as an unsupported method and answers tool calls outside a turn", async () => {
  const peer = await scriptedTransport()
  const responses = new Map<number, (value: Frame & { result?: unknown; error?: { code: number } }) => void>()
  const send = (id: number, method: string, params: unknown) => new Promise<Frame & { result?: unknown; error?: { code: number } }>((resolve) => {
    responses.set(id, resolve)
    peer.stdout.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  try {
    await peer.transport.start(peer.startInput, peer.liveBroker())
    const written = new Set<number>()
    const poll = async (id: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const frame = peer.frames.find((row) => row.id === id && row.method === undefined && !written.has(id)) as (Frame & { result?: unknown; error?: { code: number } }) | undefined
        if (frame) { written.add(id); responses.get(id)?.(frame); return }
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
    const refresh = send(0, "account/chatgptAuthTokens/refresh", { reason: "unauthorized" })
    await poll(0)
    expect((await refresh).error?.code).toBe(-32601)
    const tool = send(1, "item/tool/call", { tool: "spawn_agent", arguments: { task_name: "x", message: "y" } })
    await poll(1)
    expect((await tool).result).toEqual({ contentItems: [{ type: "inputText", text: "Dynamic tool spawn_agent is unavailable." }], success: false })
  } finally { await peer.close() }
})

test("failed Codex rebind leaves no attached entry for the retired process", async () => {
  const peer = await scriptedTransport()
  const broker = { rebind: async () => { throw new Error("rebind rejected") } } as unknown as SessionBroker
  try {
    await expect(peer.transport.start(peer.startInput, broker)).rejects.toThrow("rebind rejected")
    expect(peer.retired()).toBe(1)
    expect((peer.transport as unknown as { entries: Map<string, unknown> }).entries.has("s1")).toBe(false)
  } finally { await peer.close() }
})

test("a preceding Codex turn completion cannot end the current streamed turn", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    let settled = false
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput, { signal: new AbortController().signal } as TurnBroker)) {} })()
      .finally(() => { settled = true })
    await peer.started
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-previous", status: "completed" } } })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })}\n`)
    await running
  } finally { await peer.close() }
})

test("a malformed frame fails a Codex streamed turn and retires its process", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput,
      { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    peer.stdout.write("{malformed\n")
    await expect(running).rejects.toThrow("Invalid Codex JSON-RPC frame")
    expect(peer.retired()).toBe(1)
  } finally { await peer.close() }
})

test("a Codex turn without a resolved model starts the default model, not the thread's start or config model", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start({ ...peer.startInput, model: { providerID: "codex", modelID: "start-model" },
      config: { ...peer.startInput.config, model: { providerID: "codex", modelID: "config-model" } } }, peer.liveBroker())
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput, { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })}\n`)
    await running
    expect(peer.frames.find((frame) => frame.method === "thread/start")?.params).toMatchObject({ model: "start-model" })
    expect(peer.frames.find((frame) => frame.method === "turn/start")?.params).toMatchObject({ model: "test-model" })
  } finally { await peer.close() }
})

test("a process exit mid-turn fails the streamed turn through the channel's failure listeners", async () => {
  const peer = await scriptedTransport()
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput,
      { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    peer.exitLatest()
    await expect(running).rejects.toThrow("Codex exit failed")
  } finally { await peer.close() }
})

test("a cancel that lands before turn/start answers still interrupts the turn once its id is known", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const controller = new AbortController()
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput, { signal: controller.signal } as TurnBroker)) {} })()
    await peer.started
    controller.abort()
    peer.releaseTurnStart()
    for (let attempt = 0; attempt < 50 && !peer.frames.some((frame) => frame.method === "turn/interrupt"); attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
    expect(peer.frames.find((frame) => frame.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "turn-current" })
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "interrupted" } } })}\n`)
    await running
  } finally { await peer.close() }
})

test("Codex hands the spawn owner the whole environment and applies no scrub of its own", async () => {
  const peer = await scriptedTransport()
  const seen: Record<string, string>[] = []
  const services = (peer.transport as unknown as { services: HarnessServices }).services
  const spawn = services.spawn.bind(services)
  services.spawn = async (command, options) => { seen.push({ ...command.env }); return spawn(command, options) }
  ;(peer.transport as unknown as { options: { env?: NodeJS.ProcessEnv } }).options.env = { PATH: "/usr/bin", CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "broker-secret" }
  try {
    await peer.transport.start(peer.startInput, peer.liveBroker())
    expect(seen[0]?.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN).toBe("broker-secret")
    expect(seen[0]?.CODEX_HOME).toBeDefined()
  } finally { await peer.close() }
})

test("Codex draft probes are keyed on non-secret identity, shared across rotations of one lease, and expire", async () => {
  let now = 1_000_000
  const peer = await scriptedTransport({ clock: { now: () => now, setTimeout, clearTimeout } })
  const draft = (placeholder: string): DraftLaunch => ({ workspaceId: "w1", directory: peer.startInput.directory, locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id: "codex", access: "native" } }, projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [] },
    credentials: { providers: { codex: { baseUrl: "http://127.0.0.1:47509/v1", placeholder, authMode: "api-key" } }, secrets: { token: placeholder }, leaseGeneration: "lease-1" } })
  try {
    expect((await peer.transport.config.options({ draft: draft("secret-one") }, "probe")).options.length).toBeGreaterThan(0)
    expect(peer.spawned()).toBe(1)
    await peer.transport.config.options({ draft: draft("secret-two") }, "probe")
    expect(peer.spawned()).toBe(1)
    const probes = (peer.transport as unknown as { probes: { keys(): Iterable<string> } }).probes
    expect(JSON.stringify([...probes.keys()])).not.toContain("secret-")
    now += 31_000
    await peer.transport.config.options({ draft: draft("secret-one") }, "probe")
    expect(peer.spawned()).toBe(2)
  } finally { await peer.close() }
})

test("explicit Codex cancel waits for pending startup and interrupts within its deadline", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput, { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    const cancelling = peer.transport.cancel(session, turnInput, { at: Date.now() + 500, signal: new AbortController().signal })
    peer.releaseTurnStart()
    for (let attempt = 0; attempt < 50 && !peer.frames.some((frame) => frame.method === "turn/interrupt"); attempt++) await new Promise((resolve) => setTimeout(resolve, 2))
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "interrupted" } } })}\n`)
    await running
    expect(peer.frames.find((frame) => frame.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "turn-current" })
    expect((await cancelling).execution).toBe("terminal")
  } finally { await peer.close() }
})

test("Codex cancellation honors its deadline while startup is still pending", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = (async () => { for await (const _event of peer.transport.send(session, turnInput, { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    await expect(peer.transport.cancel(session, turnInput, { at: Date.now() + 10, signal: new AbortController().signal })).rejects.toThrow("stop deadline")
    expect(peer.frames.some((frame) => frame.method === "turn/interrupt")).toBe(false)
    peer.releaseTurnStart()
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })}\n`)
    await running
  } finally { await peer.close() }
})
