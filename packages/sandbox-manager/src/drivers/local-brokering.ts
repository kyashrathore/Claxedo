import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type Server } from "node:http"
import net from "node:net"
import path from "node:path"
import { substituteNativeSecrets } from "@claxedo/egress-broker"
import type { SandboxBrokeredSecret, SandboxDriver, SandboxDriverEnsureInput, SandboxTarget } from ".."
import { localBrokeringTestDriverCatalogEntry } from "../driver-catalog"
import { workspaceRuntimeBootEnv } from "../runtime-env"

export type LocalBrokeringDriverOptions = {
  root: string
  executable: string
  args: string[]
  allowedOrigins: readonly string[]
  inheritedEnv?: Record<string, string>
}

type Host = {
  child: ChildProcess | undefined
  proxy: Server
  directory: string
  target: SandboxTarget
  secrets: SandboxBrokeredSecret[]
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("local broker has no TCP port"))
      resolve(address.port)
    })
  })
}

async function reserveLocalRuntimePort(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") reject(new Error("local runtime has no TCP port"))
      else resolve(address.port)
    })
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function waitForLocalRuntimeHealth(url: string, child: ChildProcess) {
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`local sandbox runtime exited: ${child.exitCode}`)
    try {
      if ((await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(1_000) })).ok) return
    } catch { /* The runtime may still be binding its listener. */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("local sandbox runtime did not become healthy")
}

async function closeHost(host: Host) {
  const child = host.child
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  }
  host.proxy.closeAllConnections()
  await new Promise<void>((resolve) => host.proxy.close(() => resolve()))
  await fs.rm(host.directory, { recursive: true, force: true })
}

export function createLocalBrokeringSandboxDriver(options: LocalBrokeringDriverOptions): SandboxDriver {
  if (process.platform !== "darwin") throw new Error("local brokering test driver requires macOS sandbox-exec network policy")
  const hosts = new Map<string, Host>()
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin))

  async function ensureHost(input: SandboxDriverEnsureInput): Promise<SandboxTarget> {
    const existing = hosts.get(input.workspaceId)
    if (existing) {
      const oldNames = existing.secrets.map((secret) => secret.name).sort().join("\0")
      const newNames = (input.secrets ?? []).map((secret) => secret.name).sort().join("\0")
      if (oldNames !== newNames) {
        await stop(existing.target)
        return ensureHost(input)
      }
      existing.secrets = [...(input.secrets ?? [])]
      return existing.target
    }
    const directory = await fs.mkdtemp(path.join(options.root, "local-brokered-"))
    const workspace = path.resolve(input.workspaceRoot ?? path.join(directory, "workspace"))
    const relative = path.relative(options.root, workspace)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      await fs.rm(directory, { recursive: true, force: true })
      throw new Error("local sandbox workspace must stay under its private test root")
    }
    const home = path.join(directory, "home")
    await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(home)])
    const runtimePort = await reserveLocalRuntimePort()
    const hostId = input.hostId ?? `local-${input.workspaceId}`
    const target: SandboxTarget = {
      workspaceId: input.workspaceId,
      sandboxId: `${input.workspaceId}-${input.epoch}`,
      url: `http://127.0.0.1:${runtimePort}`,
      hostId,
      driverResourceId: `${input.workspaceId}-${input.epoch}`,
      labels: input.labels,
      driver: { id: "local-brokering-test", resourceId: `${input.workspaceId}-${input.epoch}` },
    }
    const proxy = createServer(async (request, response) => {
      try {
        const targetUrl = new URL(request.url ?? "")
        if (!allowedOrigins.has(targetUrl.origin)) throw new Error("destination_refused")
        const method = request.method ?? "GET"
        const incoming = new Headers()
        for (const [name, values] of Object.entries(request.headers)) {
          if (Array.isArray(values)) for (const value of values) incoming.append(name, value)
          else if (values !== undefined) incoming.append(name, values)
        }
        const headers = substituteNativeSecrets(targetUrl, method, incoming, host.secrets)
        for (const name of ["host", "connection", "proxy-connection", "content-length", "transfer-encoding"]) headers.delete(name)
        const chunks: Buffer[] = []
        if (method !== "GET" && method !== "HEAD") for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const upstream = await fetch(targetUrl, {
          method,
          headers,
          body: chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined,
          redirect: "manual",
        })
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
        response.end(Buffer.from(await upstream.arrayBuffer()))
      } catch {
        response.writeHead(403).end("local sandbox egress refused")
      }
    })
    proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"))
    proxy.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"))
    const host: Host = { directory, target, secrets: [...(input.secrets ?? [])], proxy, child: undefined }
    try {
      const proxyPort = await listen(proxy)
      const proxyUrl = `http://127.0.0.1:${proxyPort}`
      const env: Record<string, string> = {
        ...options.inheritedEnv,
        ...workspaceRuntimeBootEnv({
          workspaceId: input.workspaceId,
          hostId,
          directory: workspace,
          port: runtimePort,
          source: input.source,
          env: input.env,
        }),
        ...Object.fromEntries(host.secrets.map((secret) => [secret.name, `claxedo-broker:${secret.name}`])),
        HOME: home,
        TMPDIR: directory,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: "",
        no_proxy: "",
        NODE_USE_ENV_PROXY: "1",
      }
      for (const secret of host.secrets) {
        if (Object.values(env).some((value) => value.includes(secret.value))) throw new Error("brokered secret entered sandbox environment")
      }
      const networkPolicy = `(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote tcp "localhost:${proxyPort}"))`
      const child = spawn("/usr/bin/sandbox-exec", ["-p", networkPolicy, options.executable, ...options.args], {
        cwd: workspace,
        env,
        stdio: "ignore",
      })
      host.child = child
      if (!child.pid) throw new Error("local sandbox runtime did not start")
      hosts.set(input.workspaceId, host)
      await waitForLocalRuntimeHealth(target.url, child)
      const targets = path.join(options.root, "local-broker-targets")
      await fs.mkdir(targets, { recursive: true })
      await fs.writeFile(path.join(targets, `${input.workspaceId}.json`), JSON.stringify({ url: target.url, directory: workspace, home, pid: child.pid, secretNames: host.secrets.map((secret) => secret.name) }))
      return target
    } catch (error) {
      if (host.child) await closeHost(host)
      else {
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
        await fs.rm(directory, { recursive: true, force: true })
      }
      hosts.delete(input.workspaceId)
      throw error
    }
  }

  async function stop(target: SandboxTarget) {
    const host = hosts.get(target.workspaceId ?? "")
    if (!host) return
    hosts.delete(target.workspaceId ?? "")
    await closeHost(host)
    await fs.rm(path.join(options.root, "local-broker-targets", `${target.workspaceId}.json`), { force: true })
  }

  return {
    id: "local-brokering-test",
    metadata: localBrokeringTestDriverCatalogEntry.metadata,
    ensureHost,
    resumeHost: ({ ensure }) => ensureHost(ensure),
    inspect: async (target) => hosts.get(target.workspaceId ?? "")?.target,
    touch: async () => {},
    stop,
    suspend: stop,
    destroy: stop,
  }
}
