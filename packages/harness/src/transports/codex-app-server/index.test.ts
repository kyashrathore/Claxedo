import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { HarnessServices, OwnedProcess, SessionBroker, StartInput, TurnBroker, TurnInput } from "../../contract"
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
  const services = { spawn: async () => process,
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

test("Codex owner refresh and dynamic tool requests receive protocol responses", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-requests-"))
  const home = path.join(root, "owner")
  await fs.mkdir(home)
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "old-refresh", account_id: "account-1" } }))
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exit!: (value: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
  const responses = new Map<number, (value: Record<string, unknown>) => void>()
  stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const frame = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown }
      if (frame.method === "initialize") stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`)
      else if (frame.method === "thread/start") stdout.write(`${JSON.stringify({ id: frame.id, result: { thread: { id: "thread-1" } } })}\n`)
      else if (frame.id !== undefined) responses.get(frame.id)?.(frame)
    }
  })
  const process: OwnedProcess = { pid: 5_000_001, stdin, stdout, stderr: new PassThrough(), exited,
    retire: async () => { exit({ code: 0, signal: null }); return { stopped: true } } }
  const services = { spawn: async () => process, firstPartyMcp: () => undefined,
    clock: { now: Date.now, setTimeout, clearTimeout } } as unknown as HarnessServices
  const transport = new CodexAppServerTransport(services, { binary: "unused", homeRoot: path.join(root, "homes"), ownerHome: home,
    fetch: async () => new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), { status: 200 }) })
  const broker = { rebind: rebindTo("/work"), goal: { publish: async () => {} } } as unknown as SessionBroker
  const send = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve) => {
    responses.set(id, resolve)
    stdout.write(`${JSON.stringify({ id, method, params })}\n`)
  })
  try {
    await transport.start({ ...input, projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [] } }, broker)
    expect((await send(0, "account/chatgptAuthTokens/refresh", {})).result).toEqual({
      accessToken: "new-access", chatgptAccountId: "account-1", chatgptPlanType: null,
    })
    expect((await send(1, "item/tool/call", { tool: "spawn_agent" })).result).toEqual({
      contentItems: [{ type: "inputText", text: "Dynamic tool spawn_agent is unavailable." }], success: false,
    })
  } finally { await transport.dispose(); await fs.rm(root, { recursive: true, force: true }) }
})

async function scriptedTransport() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-scripted-"))
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exit!: (value: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
  let turnStarted!: () => void
  const started = new Promise<void>((resolve) => { turnStarted = resolve })
  let retired = 0
  const frames: { id?: number; method?: string; params?: unknown }[] = []
  stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const frame = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
      frames.push(frame)
      if (frame.id === undefined) continue
      const result = frame.method === "thread/start" ? { thread: { id: "thread-1" } }
        : frame.method === "model/list" ? { data: [{ model: "test-model", isDefault: true }] }
          : frame.method === "turn/start" ? { turn: { id: "turn-current" } } : {}
      stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`)
      if (frame.method === "turn/start") turnStarted()
    }
  })
  const process: OwnedProcess = { pid: 5_000_002, stdin, stdout, stderr: new PassThrough(), exited,
    retire: async () => { retired++; exit({ code: 0, signal: null }); return { stopped: true } } }
  const services = { spawn: async () => process, firstPartyMcp: () => undefined,
    clock: { now: Date.now, setTimeout, clearTimeout } } as unknown as HarnessServices
  const transport = new CodexAppServerTransport(services, { binary: "unused", homeRoot: path.join(root, "homes"), ownerHome: path.join(root, "owner") })
  const startInput = { ...input, directory: root, projection: { generation: "g1", pluginRoots: [], notApplied: [], mcpServers: [] } }
  const close = async () => { await transport.dispose(); await fs.rm(root, { recursive: true, force: true }) }
  return { transport, startInput, stdout, started, frames, retired: () => retired, close }
}

test("failed Codex rebind leaves no attached entry for the retired process", async () => {
  const peer = await scriptedTransport()
  const broker = { rebind: async () => { throw new Error("rebind rejected") } } as unknown as SessionBroker
  const session = { directory: peer.startInput.directory, locality: "local", binding: {
    sessionId: "s1", workspaceId: "w1", directory: peer.startInput.directory, connectionId: "codex-app-server", upstreamSessionId: "thread-1",
  } }
  try {
    await expect(peer.transport.start(peer.startInput, broker)).rejects.toThrow("rebind rejected")
    expect(peer.retired()).toBe(1)
    expect((peer.transport as unknown as { entries: Map<string, unknown> }).entries.has(session.binding.sessionId)).toBe(false)
  } finally { await peer.close() }
})

test("a preceding Codex turn completion cannot end the current streamed turn", async () => {
  const peer = await scriptedTransport()
  const broker = { rebind: rebindTo(peer.startInput.directory), goal: { publish: async () => {} }, reportFailure: () => {} } as unknown as SessionBroker
  try {
    const session = await peer.transport.start(peer.startInput, broker)
    const turn = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Reply" }] }, todos: [] } as TurnInput
    const turnBroker = { signal: new AbortController().signal } as TurnBroker
    let settled = false
    const running = (async () => { for await (const _event of peer.transport.send(session, turn, turnBroker)) {} })()
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
  const broker = { rebind: rebindTo(peer.startInput.directory), goal: { publish: async () => {} }, reportFailure: () => {} } as unknown as SessionBroker
  try {
    const session = await peer.transport.start(peer.startInput, broker)
    const turn = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Reply" }] }, todos: [] } as TurnInput
    const running = (async () => { for await (const _event of peer.transport.send(session, turn,
      { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    peer.stdout.write("{malformed\n")
    await expect(running).rejects.toThrow("Invalid Codex JSON-RPC frame")
    expect(peer.retired()).toBe(1)
  } finally { await peer.close() }
})

test("a Codex turn without a resolved model starts the default model, not the thread's start or config model", async () => {
  const peer = await scriptedTransport()
  const broker = { rebind: rebindTo(peer.startInput.directory), goal: { publish: async () => {} }, reportFailure: () => {} } as unknown as SessionBroker
  try {
    const session = await peer.transport.start({ ...peer.startInput, model: { providerID: "codex", modelID: "start-model" },
      config: { ...peer.startInput.config, model: { providerID: "codex", modelID: "config-model" } } }, broker)
    const turn = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
      prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Reply" }] }, todos: [] } as TurnInput
    const running = (async () => { for await (const _event of peer.transport.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {} })()
    await peer.started
    peer.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })}\n`)
    await running
    expect(peer.frames.find((frame) => frame.method === "thread/start")?.params).toMatchObject({ model: "start-model" })
    expect(peer.frames.find((frame) => frame.method === "turn/start")?.params).toMatchObject({ model: "test-model" })
  } finally { await peer.close() }
})
