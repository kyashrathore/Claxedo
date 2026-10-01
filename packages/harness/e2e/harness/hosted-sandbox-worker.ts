import { randomUUID } from "node:crypto"
import { appendFile, cp, readFile, rm, stat } from "node:fs/promises"
import { createServer, request as httpsRequest } from "node:https"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { brokeredSecretFromRegistration } from "@claxedo/egress-broker"
import { createLocalBrokeringSandboxDriver } from "@claxedo/sandbox-manager/drivers/local-brokering"
import type { SandboxBrokeredSecret, SandboxTarget } from "@claxedo/sandbox-manager"
import { parseRegistrations, type EgressRegistration } from "../../../claxedo-server/scripts/sandbox/cloudflare-worker/src/outbound-credentials"
import { claxedoAgentPluginsWorkspaceRuntimeEntry } from "../../../claxedo-server/src/hosts/workspace-runtime/startup"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { PINNED_PI } from "./pinned-pi"
import { scriptedGithub } from "./hosted-scripted-github"
import { scriptedHostedMcp } from "./hosted-scripted-mcp"
import { hostedFaultSecrets } from "./cloud-faults"

/** The plugin MCP gateway's own origin, as production keeps it apart from the control plane's. */
export const HOSTED_MCP_GATEWAY_ORIGIN = "https://gateway.hosted-e2e.test"

type HostedSandboxWorkerInput = {
  root: string
  port: number
  token: string
  certificate: string
  key: string
  controlPlaneUrl: string
  modelUrl: string
  gitUrl: string
  relayUrl: string
}

type RunningSandbox = {
  target: SandboxTarget
  labels: Record<string, string>
  registrations: EgressRegistration[]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object")
  return value as Record<string, unknown>
}

function stringMap(value: unknown): Record<string, string> {
  const input = record(value)
  if (Object.values(input).some((entry) => typeof entry !== "string")) throw new Error("expected string map")
  return input as Record<string, string>
}

function response(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

async function sendResponse(res: ServerResponse, result: Response) {
  res.writeHead(result.status, Object.fromEntries(result.headers)).end(Buffer.from(await result.arrayBuffer()))
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

function localSecrets(registrations: EgressRegistration[]): SandboxBrokeredSecret[] {
  return registrations.map((row) => {
    const secret = brokeredSecretFromRegistration(row)
    return { ...secret, hosts: [...secret.hosts] }
  })
}

function runtimeEnv(env: Record<string, string>, root: string, sandboxId: string) {
  const omitted = new Set([
    "WORKSPACE_RUNTIME_WORKSPACE_ID",
    "WORKSPACE_RUNTIME_HOST_ID",
    "WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS",
    "WORKSPACE_RUNTIME_DIRECTORY",
    "WORKSPACE_RUNTIME_PORT",
    "WORKSPACE_RUNTIME_HOST",
    "WORKSPACE_RUNTIME_SOURCE_KIND",
    "WORKSPACE_RUNTIME_GIT_REPO_URL",
    "WORKSPACE_RUNTIME_GIT_BRANCH",
    "CLAXEDO_DATA_DIR",
  ])
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !omitted.has(name))),
    CLAXEDO_DATA_DIR: path.join(root, "runtime-data", sandboxId),
  }
}

function source(env: Record<string, string>) {
  if (env.WORKSPACE_RUNTIME_SOURCE_KIND === "empty") return { kind: "empty" as const }
  if (env.WORKSPACE_RUNTIME_SOURCE_KIND !== "git" || !env.WORKSPACE_RUNTIME_GIT_REPO_URL) {
    throw new Error("unknown workspace-runtime source")
  }
  return {
    kind: "git" as const,
    repoUrl: env.WORKSPACE_RUNTIME_GIT_REPO_URL,
    ...(env.WORKSPACE_RUNTIME_GIT_BRANCH ? { branch: env.WORKSPACE_RUNTIME_GIT_BRANCH } : {}),
  }
}

/** The two trees the Cloudflare driver asks a backup to capture: the workspace and the runtime's data directory. */
const BACKED_UP = ["sandbox-workspaces", "runtime-data"] as const

async function exists(file: string) {
  return stat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false
    throw error
  })
}

async function backUpSandbox(root: string, sandboxId: string) {
  const backupId = `backup-${randomUUID()}`
  for (const tree of BACKED_UP) {
    const live = path.join(root, tree, sandboxId)
    if (await exists(live)) await cp(live, path.join(root, "sandbox-backups", backupId, tree), { recursive: true })
  }
  return backupId
}

async function restoreSandbox(root: string, sandboxId: string, backupId: string) {
  const backup = path.join(root, "sandbox-backups", backupId)
  if (!(await exists(backup))) return false
  for (const tree of BACKED_UP) {
    const live = path.join(root, tree, sandboxId)
    await rm(live, { recursive: true, force: true })
    if (await exists(path.join(backup, tree))) await cp(path.join(backup, tree), live, { recursive: true })
  }
  return true
}

function proxy(request: IncomingMessage, responseStream: ServerResponse, target: SandboxTarget, rest: string, search: string) {
  const destination = new URL(target.url)
  destination.pathname = `/${rest}`
  destination.search = search
  return forward(request, responseStream, destination)
}

function forward(request: IncomingMessage, responseStream: ServerResponse, destination: URL) {
  const headers = { ...request.headers }
  delete headers.host
  delete headers["x-claxedo-e2e-target-url"]
  const upstream = http.request(destination, { method: request.method, headers }, (received) => {
    responseStream.writeHead(received.statusCode ?? 502, received.headers)
    received.pipe(responseStream)
  })
  upstream.on("error", (error) => {
    if (!responseStream.headersSent) response(responseStream, 502, { error: error.message })
    else responseStream.destroy(error)
  })
  request.pipe(upstream)
}

/**
 * The brokering driver forwards a sandbox's gateway requests to a loopback
 * HTTP destination; the control plane serves HTTPS on its own origin, which
 * in production is the gateway's origin too, so this listener carries them
 * across under the control plane's host. Bodies stay uncompressed because the
 * driver's own forwarder re-sends the upstream headers over a decoded body.
 */
async function startGatewayForwarder(controlPlaneUrl: string) {
  const target = new URL(controlPlaneUrl)
  const server = http.createServer((request, res) => {
    const headers = { ...request.headers, host: target.host, "accept-encoding": "identity" }
    const upstream = httpsRequest({ hostname: target.hostname, port: target.port, path: request.url, method: request.method, headers }, (received) => {
      res.writeHead(received.statusCode ?? 502, received.headers)
      received.pipe(res)
    })
    upstream.on("error", (error) => {
      if (!res.headersSent) response(res, 502, { error: error.message })
      else res.destroy(error)
    })
    request.pipe(upstream)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("gateway forwarder has no port")
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

const LOCALHOST_RESOLVER = pathToFileURL(path.join(import.meta.dirname, "localhost-resolver.mjs")).href

export async function startHostedSandboxWorker(input: HostedSandboxWorkerInput) {
  const textImports = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
  const gateway = await startGatewayForwarder(input.controlPlaneUrl)
  const driver = createLocalBrokeringSandboxDriver({
    root: input.root,
    executable: process.env.CLAXEDO_E2E_NODE ?? process.execPath,
    // The VM image's own entry: the Claxedo runtime composition with the Agent Plugins apply route mounted.
    args: ["--conditions=development", "--import", textImports, "--import", LOCALHOST_RESOLVER, "--import", TSX_LOADER, claxedoAgentPluginsWorkspaceRuntimeEntry()],
    allowedOrigins: [input.controlPlaneUrl, input.relayUrl, new URL(input.gitUrl).origin],
    directOrigins: [input.controlPlaneUrl, input.relayUrl, new URL(input.gitUrl).origin],
    upstreams: { "https://api.openai.com": input.modelUrl, "https://api.anthropic.com": input.modelUrl, [HOSTED_MCP_GATEWAY_ORIGIN]: gateway.url },
    inheritedEnv: {
      PATH: process.env.PATH ?? "",
      PI_EXECUTABLE: PINNED_PI,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.CI ? { CI: process.env.CI } : {}),
      NODE_EXTRA_CA_CERTS: input.certificate,
    },
  })
  const destroy = driver.destroy
  if (!destroy) throw new Error("local brokering driver must support destroy")
  const touch = driver.touch
  if (!touch) throw new Error("local brokering driver must support touch")
  const sandboxes = new Map<string, RunningSandbox>()
  const ensuring = new Set<Promise<unknown>>()
  const server = createServer({ key: await readFile(input.key), cert: await readFile(input.certificate) }, async (request, res) => {
    try {
      const original = new URL(request.url ?? "/", `https://127.0.0.1:${input.port}`)
      const outbound = original.pathname === "/__outbound"
      const outboundTarget = outbound ? request.headers["x-claxedo-e2e-target-url"] : undefined
      if (outbound && typeof outboundTarget !== "string") return response(res, 400, { error: "outbound target required" })
      const url = typeof outboundTarget === "string" ? new URL(outboundTarget) : original
      if (outbound) {
        const github = await scriptedGithub(request, url)
        if (github) return sendResponse(res, github)
        const mcp = await scriptedHostedMcp(request, url, input.root)
        if (mcp) return sendResponse(res, mcp)
        if (url.origin === new URL(input.relayUrl).origin) return forward(request, res, url)
        if (url.origin !== `https://127.0.0.1:${input.port}`) {
          await appendFile(path.join(input.root, "hosted-outbound-attempts.jsonl"), JSON.stringify({ method: request.method, url: url.href }) + "\n")
          return response(res, 599, { error: "outbound refused by hosted e2e" })
        }
      }
      const parts = url.pathname.split("/").filter(Boolean)
      const id = parts[1]
      if (parts[0] === "sandbox" && id && parts[2] === "proxy") {
        const running = sandboxes.get(id)
        if (!running) return response(res, 404, { error: "sandbox not found" })
        return proxy(request, res, running.target, parts.slice(3).join("/"), url.search)
      }
      if (request.headers.authorization !== `Bearer ${input.token}`) return response(res, 401, { error: "unauthorized" })
      if (url.pathname === "/sandboxes" && request.method === "GET") {
        return response(res, 200, { supported: true, sandboxes: [...sandboxes].map(([sandboxId, entry]) => ({ sandboxId, ...entry.labels })) })
      }
      if (parts[0] !== "sandbox" || !id) return response(res, 404, { error: "not found" })
      if (request.method === "DELETE" && !parts[2]) {
        const running = sandboxes.get(id)
        if (!running) return response(res, 404, { error: "sandbox not found" })
        await destroy(running.target)
        sandboxes.delete(id)
        return response(res, 200, { ok: true })
      }
      if (request.method !== "POST") return response(res, 405, { error: "method not allowed" })
      if (parts[2] === "touch-runtime") {
        const running = sandboxes.get(id)
        if (!running) return response(res, 404, { error: "sandbox not found" })
        await touch(running.target)
        return response(res, 200, { ok: true, ready: true })
      }
      if (parts[2] === "backup") {
        if (!sandboxes.has(id)) return response(res, 404, { error: "sandbox not found" })
        return response(res, 200, { backupId: await backUpSandbox(input.root, id) })
      }
      if (parts[2] !== "ensure-runtime") return response(res, 404, { error: "unknown action" })
      const payload = await body(request)
      const env = stringMap(payload.env)
      if (env.WORKSPACE_RUNTIME_GIT_REPO_URL && env.WORKSPACE_RUNTIME_GIT_REPO_URL !== input.gitUrl) {
        return response(res, 403, { error: "git source refused by hosted sandbox emulator" })
      }
      const labels = stringMap(payload.labels)
      const workspaceId = env.WORKSPACE_RUNTIME_WORKSPACE_ID
      if (!workspaceId || id !== `claxedo-${workspaceId}` || env.WORKSPACE_RUNTIME_HOST_ID !== id) {
        return response(res, 400, { error: "sandbox runtime identity mismatch" })
      }
      if (payload.command !== "/usr/local/bin/workspace-runtime" || payload.port !== Number(env.WORKSPACE_RUNTIME_PORT)) {
        return response(res, 400, { error: "unknown runtime command or port" })
      }
      if (payload.restore !== undefined) {
        const backupId = record(payload.restore).backupId
        if (typeof backupId !== "string" || !(await restoreSandbox(input.root, id, backupId))) return response(res, 404, { error: "backup not found" })
      }
      const previous = sandboxes.get(id)
      const registrations = payload.egress === undefined ? previous?.registrations ?? [] : parseRegistrations(payload.egress)
      if (registrations.some((row) => Object.values(env).some((value) => value.includes(row.value)))) {
        return response(res, 400, { error: "brokered secret entered runtime env" })
      }
      const starting = (async () => {
        const target = await driver.ensureHost({
          workspaceId,
          hostId: id,
          homeRegion: "us-east",
          epoch: Number(labels.epoch ?? "1"),
          labels,
          source: source(env),
          workspaceRoot: path.join(input.root, "sandbox-workspaces", id),
          env: runtimeEnv(env, input.root, id),
          secrets: hostedFaultSecrets(localSecrets(registrations), process.env.CLAXEDO_E2E_HOSTED_FAULT),
        })
        if (!("provisioning" in target)) sandboxes.set(id, { target, labels, registrations })
        return target
      })()
      ensuring.add(starting)
      const target = await starting.finally(() => ensuring.delete(starting))
      if ("provisioning" in target) return response(res, 503, { ready: false, error: "workspace-runtime did not become ready" })
      return response(res, 200, { ready: true, url: `https://127.0.0.1:${input.port}/sandbox/${encodeURIComponent(id)}/proxy`, port: payload.port })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      return response(res, 500, { error: message })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port, "127.0.0.1", resolve)
  })
  return {
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // A runtime still starting when the stack stops would otherwise outlive
      // this process's close and keep it from exiting.
      await Promise.allSettled(ensuring)
      for (const entry of sandboxes.values()) await destroy(entry.target)
      sandboxes.clear()
      await gateway.close()
    },
  }
}

if (import.meta.main) {
  const raw = process.env.CLAXEDO_E2E_HOSTED_SANDBOX_WORKER
  if (!raw) throw new Error("missing hosted sandbox worker configuration")
  const worker = await startHostedSandboxWorker(JSON.parse(raw) as HostedSandboxWorkerInput)
  console.log("[hosted-sandbox-worker] ready")
  process.once("SIGTERM", () => { void worker.close().then(() => { process.exitCode = 0 }) })
}
