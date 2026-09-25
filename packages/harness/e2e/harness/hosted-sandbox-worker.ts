import { appendFile, readFile } from "node:fs/promises"
import { createServer } from "node:https"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createLocalBrokeringSandboxDriver } from "@claxedo/sandbox-manager/drivers/local-brokering"
import type { SandboxBrokeredSecret, SandboxTarget } from "@claxedo/sandbox-manager"
import { parseRegistrations, type EgressRegistration } from "../../../claxedo-server/scripts/sandbox/cloudflare-worker/src/outbound-credentials"
import { REPO_ROOT, TSX_LOADER } from "./node-loader"
import { scriptedGithub } from "./hosted-scripted-github"

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
    const authorization = row.header.toLowerCase() === "authorization"
    const match = authorization ? /^([A-Za-z]+) (.+)$/.exec(row.value) : null
    return {
      name: row.name,
      value: match?.[2] ?? row.value,
      hosts: row.hosts,
      header: row.header,
      ...(match ? { scheme: match[1] } : {}),
      methods: row.methods,
      pathPrefixes: row.pathPrefixes,
    }
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

function proxy(request: IncomingMessage, responseStream: ServerResponse, target: SandboxTarget, rest: string, search: string) {
  const destination = new URL(target.url)
  destination.pathname = `/${rest}`
  destination.search = search
  const headers = { ...request.headers }
  delete headers.host
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

export async function startHostedSandboxWorker(input: HostedSandboxWorkerInput) {
  const textImports = pathToFileURL(path.join(REPO_ROOT, "packages/workspace-runtime/src/text-imports.mjs")).href
  const driver = createLocalBrokeringSandboxDriver({
    root: input.root,
    executable: process.execPath,
    args: ["--conditions=development", "--import", textImports, "--import", TSX_LOADER, path.join(REPO_ROOT, "packages/workspace-runtime/src/cli.ts")],
    allowedOrigins: [input.controlPlaneUrl, input.relayUrl, input.modelUrl, new URL(input.gitUrl).origin],
    inheritedEnv: {
      PATH: process.env.PATH ?? "",
      ...(process.env.PI_EXECUTABLE ? { PI_EXECUTABLE: process.env.PI_EXECUTABLE } : {}),
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
      if (payload.restore !== undefined) return response(res, 501, { error: "local sandbox backup restore unavailable" })
      const previous = sandboxes.get(id)
      const registrations = payload.egress === undefined ? previous?.registrations ?? [] : parseRegistrations(payload.egress)
      if (registrations.some((row) => Object.values(env).some((value) => value.includes(row.value)))) {
        return response(res, 400, { error: "brokered secret entered runtime env" })
      }
      const target = await driver.ensureHost({
        workspaceId,
        hostId: id,
        homeRegion: "us-east",
        epoch: Number(labels.epoch ?? "1"),
        labels,
        source: source(env),
        workspaceRoot: path.join(input.root, "sandbox-workspaces", id),
        env: runtimeEnv(env, input.root, id),
        secrets: localSecrets(registrations),
      })
      if ("provisioning" in target) return response(res, 503, { ready: false, error: "workspace-runtime did not become ready" })
      sandboxes.set(id, { target, labels, registrations })
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
      for (const entry of sandboxes.values()) await destroy(entry.target)
      sandboxes.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
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
