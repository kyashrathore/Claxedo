import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { serve } from "@hono/node-server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { HostedMcpGatewayRoutes } from "./routes"
import { mintMcpGatewayToken, type McpGatewayTokenScope } from "./runtime-token"

const scope: McpGatewayTokenScope = {
  userId: "user-e2e",
  orgId: "org-e2e",
  projectId: "project-e2e",
  workspaceId: "workspace-e2e",
  harnessId: "opencode",
  pluginInstanceId: "claxedo:protocol-fixture",
  serverName: "fixture",
  integrationId: "mcp-protocol-fixture",
}

const temporaryRoots: string[] = []
const servers: Array<ReturnType<typeof serve>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })))
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type UpstreamCall = { method: string; sessionId?: string; authorization?: string }

function protocolUpstream(calls: UpstreamCall[]) {
  return async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (init?.method === "DELETE") return new Response(null, { status: 204 })
    if (init?.method === "GET") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } })
    const request = JSON.parse(await new Response(init?.body).text()) as {
      id?: string | number
      method: string
      params?: { protocolVersion?: string; arguments?: Record<string, unknown> }
    }
    const modern = headers.get("mcp-protocol-version") === "2026-07-28"
    calls.push({
      method: request.method,
      ...(headers.get("mcp-session-id") ? { sessionId: headers.get("mcp-session-id")! } : {}),
      ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}),
    })
    if (request.id === undefined) return new Response(null, { status: 202 })

    const result = request.method === "server/discover"
      ? {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, resources: {}, prompts: {} },
          instructions: "Protocol fixture behind the Claxedo gateway",
          _meta: {
            "io.modelcontextprotocol/serverInfo": { name: "claxedo-gateway-fixture", version: "1.0.0" },
          },
        }
      : request.method === "initialize"
      ? {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "claxedo-gateway-fixture", version: "1.0.0" },
        }
      : request.method === "tools/list"
        ? { resultType: "complete", tools: [{ name: "echo", description: "Echo fixture", inputSchema: { type: "object" } }] }
        : request.method === "tools/call"
          ? { resultType: "complete", content: [{ type: "text", text: JSON.stringify(request.params?.arguments ?? {}) }] }
          : request.method === "resources/list"
            ? { resultType: "complete", resources: [{ uri: "fixture://readme", name: "Fixture readme" }] }
            : request.method === "prompts/list"
              ? { resultType: "complete", prompts: [{ name: "fixture-prompt", description: "Fixture prompt" }] }
              : {}
    const wireResult = modern ? { ...result, resultType: "complete", ttlMs: 0, cacheScope: "private" } : result
    return Response.json({ jsonrpc: "2.0", id: request.id, result: wireResult }, {
      headers: {
        "content-type": "application/json",
        ...(!modern ? { "mcp-session-id": "gateway-session-e2e" } : {}),
      },
    })
  }
}

async function startGateway() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const env = {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
  }
  const credential = await mintMcpGatewayToken(scope, env)
  const calls: UpstreamCall[] = []
  const app = HostedMcpGatewayRoutes({
    env,
    authorize: async () => ({ resource: "https://upstream.example/mcp" }),
    resolveConnection: async () => ({
      ok: true,
      connectionId: "connection-e2e",
      token: "upstream-oauth-token",
      tokenType: "bearer",
      fields: { resource: "https://upstream.example/mcp" },
    }),
    fetch: protocolUpstream(calls),
  })
  const listening = new Promise<number>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
    servers.push(server)
  })
  const port = await listening
  return {
    calls,
    token: credential.token,
    url: `http://127.0.0.1:${port}/${scope.integrationId}`,
  }
}

function runInspector(launcher: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`Inspector timed out: ${stderr}`))
    }, 20_000)
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("exit", (status) => {
      clearTimeout(timeout)
      resolve({ status, stdout, stderr })
    })
  })
}

describe("Agent Plugins MCP gateway protocol", () => {
  test("keeps a long-lived SDK session while injecting only the Connections token upstream", async () => {
    const fixture = await startGateway()
    const transport = new StreamableHTTPClientTransport(new URL(fixture.url), {
      requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
    })
    const client = new Client({ name: "claxedo-gateway-e2e", version: "1.0.0" })
    await client.connect(transport)
    await client.listTools()
    await client.callTool({ name: "echo", arguments: { value: "through-gateway" } })
    await client.listResources()
    await client.listPrompts()
    await client.close()

    expect(fixture.calls.map((call) => call.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "resources/list",
      "prompts/list",
    ])
    expect(fixture.calls.every((call) => call.authorization === "Bearer upstream-oauth-token")).toBe(true)
    expect(fixture.calls.filter((call) => call.method !== "initialize").every(
      (call) => call.sessionId === "gateway-session-e2e",
    )).toBe(true)
  })

  test("passes the modern MCP Inspector oracle with empty Inspector OAuth storage", async () => {
    const fixture = await startGateway()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-mcp-inspector-"))
    temporaryRoots.push(root)
    const configPath = path.join(root, "mcp.json")
    const storagePath = path.join(root, "oauth")
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        gateway: {
          type: "http",
          url: fixture.url,
          protocolEra: "modern",
          headers: { Authorization: `Bearer ${fixture.token}` },
        },
      },
    }))
    const launcher = path.resolve(
      import.meta.dirname,
      "../../../node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js",
    )
    const methods = [
      ["initialize"],
      ["tools/list"],
      ["tools/call", "--tool-name", "echo", "--tool-args-json", '{"value":"inspector"}'],
      ["resources/list"],
      ["prompts/list"],
    ]

    for (const [method, ...args] of methods) {
      const run = await runInspector(launcher, [
        "--cli",
        "--config",
        configPath,
        "--server",
        "gateway",
        "--stored-auth-only",
        "--method",
        method!,
        ...args,
        "--format",
        "json",
      ], {
          ...process.env,
          MCP_STORAGE_DIR: storagePath,
          MCP_AUTO_OPEN_ENABLED: "false",
      })
      expect(run.status, `${method}: ${run.stderr}`).toBe(0)
      expect(() => JSON.parse(run.stdout)).not.toThrow()
    }

    await expect(fs.readdir(storagePath)).rejects.toMatchObject({ code: "ENOENT" })
    expect(fixture.calls.some((call) => call.method === "tools/call")).toBe(true)
    expect(fixture.calls.every((call) => call.authorization === "Bearer upstream-oauth-token")).toBe(true)
  }, 120_000)
})
