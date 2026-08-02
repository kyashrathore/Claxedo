import fs from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { createServer, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import type { ConnectionsService } from "../../../claxedo-connections/src/index"
import { createLocalEmbeddedWorkGraph } from "../../../claxedo-server/src/server-workgraph"
import { createSessionV2WorkGraphGateway } from "../../../claxedo-server/src/workgraph-session-gateway"
import { createLocalWorkspaceExecution } from "../../../claxedo-server/src/workgraph-host/local-execution"
import type { SourceIssueConnector } from "../../../workgraph/src/connectors/interface"

const apiPort = Number(process.env.CLAXEDO_WORKGRAPH_CONNECTION_API_PORT ?? 4314)
const opencodePort = Number(process.env.CLAXEDO_WORKGRAPH_CONNECTION_OPENCODE_PORT ?? 4315)
const directory = process.env.CLAXEDO_WORKGRAPH_CONNECTION_DATA ?? "/tmp/claxedo-workgraph-connection-browser-use"
const repository = path.resolve(import.meta.dirname, "../../../..")
const connectionId = "connection_browser_github"
fs.rmSync(directory, { recursive: true, force: true })
fs.mkdirSync(directory, { recursive: true })

const providerRequests: Array<Record<string, unknown>> = []
const opencodeRequests: Array<{ path: string; method: string; body?: unknown }> = []
const connectionCalls: Array<Record<string, unknown>> = []
const connectorCalls: Array<Record<string, unknown>> = []

const provider = createServer(async (incoming, outgoing) => {
  const body = JSON.parse((await readBody(incoming)).toString() || "{}") as Record<string, unknown>
  providerRequests.push(body)
  const serialized = JSON.stringify(body)
  if (serialized.includes("Generate a title for this conversation")) {
    sendText(outgoing, "Connection E2E")
    return
  }
  if (serialized.includes("Connection-bound browser issue")) {
    sendText(outgoing, "Connection broker result reached the provider continuation")
    return
  }
  sendTool(outgoing, "connection_work_source_list", {
    connectionId,
    providerUserId: "octocat",
    filters: { repo: "claxedo/claxedo", state: "open" },
  })
})
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
const providerAddress = provider.address()
if (!providerAddress || typeof providerAddress === "string") throw new Error("Fake provider failed to bind")

const opencode = spawn(
  "bun",
  ["run", "--conditions=browser", "./src/index.ts", "serve", "--pure", "--hostname", "127.0.0.1", "--port", String(opencodePort)],
  {
    cwd: path.join(repository, "packages/opencode"),
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig(`http://127.0.0.1:${providerAddress.port}/v1`)),
      BROWSER_E2E_API_KEY: "test-key",
      XDG_CACHE_HOME: path.join(directory, "xdg-cache"),
      XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
      XDG_DATA_HOME: path.join(directory, "xdg-data"),
      OPENCODE_DISABLE_AUTOSHARE: "true",
      // Same hermetic-boot guard as real-workgraph-harness.ts: with a fresh
      // XDG_CACHE_HOME and no baked models snapshot (source run), the engine would
      // otherwise fetch models.dev during startup, and until that lands the catalog
      // is empty and the config-defined fake provider cannot resolve.
      OPENCODE_DISABLE_MODELS_FETCH: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
const opencodeLogs: string[] = []
opencode.stdout.on("data", (chunk) => opencodeLogs.push(String(chunk)))
opencode.stderr.on("data", (chunk) => opencodeLogs.push(String(chunk)))
await waitForServer(`http://127.0.0.1:${opencodePort}/global/health`)

const connections = {
  getById: async (id: string) => {
    connectionCalls.push({ type: "getById", id })
    if (id !== connectionId) return
    return {
      id,
      integrationId: "github",
      owner: "org:local",
      grantedCapabilities: ["work-source"],
      fields: {},
      createdAt: 1,
      updatedAt: 1,
    }
  },
  getToken: async (id: string, capability: string) => {
    connectionCalls.push({ type: "getToken", id, capability })
    return { ok: true as const, response: { token: "browser-e2e-secret", tokenType: "bearer" as const } }
  },
  reportAuthFailure: async (id: string, reason: string) => {
    connectionCalls.push({ type: "reportAuthFailure", id, reason })
  },
} as unknown as ConnectionsService

const github: SourceIssueConnector = {
  provider: "github",
  async list(authorization, input) {
    connectorCalls.push({
      type: "list",
      providerUserId: input.providerUserId,
      filters: input.filters,
      authorized: authorization.token === "browser-e2e-secret" && authorization.tokenType === "bearer",
    })
    return {
      issues: [
        {
          externalId: "101",
          externalKey: "#101",
          externalUrl: "https://github.example/claxedo/claxedo/issues/101",
          title: "Connection-bound browser issue",
          body: "Reached through the WorkGraph Connection broker.",
          status: "open",
          updatedAt: 1,
          revision: "browser-e2e-1",
        },
      ],
    }
  },
  async comment() {
    throw new Error("Unexpected comment operation")
  },
  async update() {
    throw new Error("Unexpected update operation")
  },
}

const sessionGateway = createSessionV2WorkGraphGateway(
  async (request) => {
    const url = new URL(request.url)
    opencodeRequests.push({
      path: url.pathname,
      method: request.method,
      ...(request.body ? { body: await request.clone().json() } : {}),
    })
    return fetch(`http://127.0.0.1:${opencodePort}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(["GET", "HEAD"].includes(request.method) ? {} : { body: request.body, duplex: "half" as const }),
    })
  },
  { connections, connectors: { github }, resolveTeamOwner: (context) => `org:${context.organizationId}` },
)
const sessions = {
  ...sessionGateway,
  admit: async (input: Parameters<typeof sessionGateway.admit>[0]) => {
    // Core V2 intentionally loads Location config from disk, so put the fake
    // provider in the disposable WorkGraph worktree before the Location opens.
    fs.writeFileSync(path.join(input.directory, "opencode.json"), JSON.stringify(providerConfig(`http://127.0.0.1:${providerAddress.port}/v1`)))
    return sessionGateway.admit(input)
  },
}

type WorkGraphDatabase = Parameters<typeof createLocalEmbeddedWorkGraph>[0]["database"]
const Database = createRequire(import.meta.url)(
  path.resolve(import.meta.dirname, "../../../claxedo-server/node_modules/better-sqlite3"),
) as new (filename: string) => WorkGraphDatabase
const database = new Database(path.join(directory, "workgraph.sqlite"))
const execution = createLocalWorkspaceExecution({
  worktreeRoot: path.join(directory, "worktrees"),
  repositoryDirectory: async () => repository,
  sessions,
})
const embedded = await createLocalEmbeddedWorkGraph({ database, execution })
const api = createServer(async (incoming, outgoing) => {
  if (incoming.method === "OPTIONS") {
    outgoing.statusCode = 204
    outgoing.setHeader("access-control-allow-origin", "*")
    outgoing.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS")
    outgoing.setHeader("access-control-allow-headers", "authorization,content-type")
    outgoing.end()
    return
  }
  if (incoming.method === "GET" && incoming.url === "/api/claxedo/health") {
    json(outgoing, {
      ok: true,
      harnessMode: "workspace",
      workspaceProfile: "workspace",
      localExecution: true,
      connectionProvider: true,
    })
    return
  }
  if (incoming.method === "GET" && incoming.url === "/e2e/evidence") {
    json(outgoing, {
      providerRequests,
      opencodeRequests,
      connectionCalls,
      connectorCalls,
      staleCallback: await staleCallbackEvidence(),
      opencodeLogs: opencodeLogs.slice(-20),
    })
    return
  }
  const body = await readBody(incoming)
  const requestPath = (incoming.url ?? "/").replace(/^\/api\/workgraph/, "") || "/"
  const request = new Request(`http://127.0.0.1:${apiPort}${requestPath}`, {
    method: incoming.method,
    headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, Array.isArray(value) ? value.join(",") : value]],
    ),
    ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: body.toString() }),
  })
  const response = await embedded.router.fetch(request)
  outgoing.statusCode = response.status
  response.headers.forEach((value, key) => outgoing.setHeader(key, value))
  outgoing.setHeader("access-control-allow-origin", "*")
  outgoing.end(Buffer.from(await response.arrayBuffer()))
})
await new Promise<void>((resolve) => api.listen(apiPort, "127.0.0.1", resolve))
const reconcile = setInterval(() =>
  void embedded.reconcile({
    organizationId: "local" as never,
    ownerUserId: "local" as never,
    actor: { type: "system", id: "connection-browser-reconciler" as never },
    requestId: crypto.randomUUID() as never,
    access: { mode: "owner" },
  }), 50,
)

let closing = false
const close = async () => {
  if (closing) return
  closing = true
  clearInterval(reconcile)
  await Promise.all([
    new Promise<void>((resolve) => api.close(() => resolve())),
    new Promise<void>((resolve) => provider.close(() => resolve())),
  ])
  opencode.kill("SIGTERM")
  database.close()
  removeHarnessWorktrees()
  fs.rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.on("SIGINT", () => void close())
process.on("SIGTERM", () => void close())
console.log(`WorkGraph Connection Browser Use server listening on http://127.0.0.1:${apiPort}`)

function readBody(incoming: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    incoming.on("end", () => resolve(Buffer.concat(chunks)))
    incoming.on("error", reject)
  })
}

function json(outgoing: ServerResponse, body: unknown) {
  outgoing.setHeader("content-type", "application/json")
  outgoing.setHeader("access-control-allow-origin", "*")
  outgoing.end(JSON.stringify(body))
}

function sendText(outgoing: ServerResponse, text: string) {
  sendSse(outgoing, [
    { choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: usage() },
  ])
}

function sendTool(outgoing: ServerResponse, name: string, input: unknown) {
  sendSse(outgoing, [
    { choices: [{ delta: { role: "assistant" } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_browser_connection",
            type: "function",
            function: { name, arguments: "" },
          }],
        },
      }],
    },
    {
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }] },
      }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: usage() },
  ])
}

function sendSse(outgoing: ServerResponse, chunks: unknown[]) {
  outgoing.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  chunks.forEach((chunk) => outgoing.write(`data: ${JSON.stringify(chunk)}\n\n`))
  outgoing.end("data: [DONE]\n\n")
}

function usage() {
  return { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
}

function providerConfig(baseURL: string) {
  return {
    model: "test/test-model",
    providers: {
      test: {
        name: "Test",
        env: ["BROWSER_E2E_API_KEY"],
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: baseURL,
          settings: { apiKey: "test-key" },
        },
        models: {
          "test-model": {
            name: "Test Model",
            api: {
              id: "test-model",
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: baseURL,
              settings: { apiKey: "test-key" },
            },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            request: { body: { apiKey: "test-key" } },
            variants: [{ id: "high" }],
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (opencode.exitCode !== null) throw new Error(`OpenCode exited before readiness:\n${opencodeLogs.join("")}`)
    const ready = await fetch(url).then((response) => response.ok, () => false)
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`OpenCode did not become ready:\n${opencodeLogs.join("")}`)
}

function removeHarnessWorktrees() {
  const root = path.join(directory, "worktrees")
  const listed = spawnSync("git", ["-C", repository, "worktree", "list", "--porcelain"], { encoding: "utf8" })
  listed.stdout
    .split("\n")
    .flatMap((line) => line.startsWith("worktree ") ? [line.slice("worktree ".length)] : [])
    .filter((candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`))
    .sort((left, right) => right.length - left.length)
    .forEach((candidate) => spawnSync("git", ["-C", repository, "worktree", "remove", "--force", candidate]))
}

async function staleCallbackEvidence() {
  const registration = opencodeRequests.find((request) => request.method === "POST" && request.path.endsWith("/tool"))
  const callbackUrl = registration?.body && typeof registration.body === "object"
    && "callbackUrl" in registration.body && typeof registration.body.callbackUrl === "string"
    ? registration.body.callbackUrl
    : undefined
  const sessionId = registration?.path.split("/").at(-2)
  const cleaned = !!sessionId && opencodeRequests.some((request) =>
    request.method === "DELETE" && request.path === `/api/session/${sessionId}/tool`,
  )
  if (!callbackUrl || !sessionId || !cleaned) return { cleaned, rejected: false }
  const status = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionID: sessionId,
      name: "connection_work_source_list",
      input: { connectionId, providerUserId: "octocat", filters: {} },
      toolCallID: "call_stale_browser_probe",
    }),
  }).then((response) => response.status, () => "unreachable")
  return { cleaned, rejected: status === "unreachable" || status === 403 || status === 404, status }
}
