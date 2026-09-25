import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { HarnessServices, OwnedProcess, SessionBroker, StartInput } from "../../contract"
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
  const broker = { rebind: async () => {}, goal: { publish: async () => {} } } as unknown as SessionBroker
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
