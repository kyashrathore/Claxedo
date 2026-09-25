import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"
import { substituteNativeSecrets } from "@claxedo/egress-broker"
import type { SandboxBrokeredSecret, SandboxDriver, SandboxDriverEnsureInput, SandboxTarget } from ".."
import { localBrokeringTestDriverCatalogEntry } from "../driver-catalog"
import { workspaceRuntimeBootEnv } from "../runtime-env"

export type LocalBrokeringDriverOptions = {
  root: string
  executable: string
  args: string[]
  allowedOrigins: readonly string[]
  controlPlaneOrigin: string
  relayOrigin?: string
  upstreams?: Readonly<Record<string, string>>
  inheritedEnv?: Record<string, string>
}

type Host = {
  child: ChildProcess | undefined
  proxy: Server
  directory: string
  target: SandboxTarget
  secrets: SandboxBrokeredSecret[]
  tunnels: Set<Duplex>
}

function createTestAuthority(root: string) {
  const privateDirectory = realpathSync(mkdtempSync(path.join(root, "local-broker-ca-")))
  const certificate = path.join(root, `${path.basename(privateDirectory)}.pem`)
  const key = path.join(privateDirectory, "ca.key")
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-subj", "/CN=Claxedo local broker test CA", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" })
  return { certificate, privateDirectory, key, leaves: new Map<string, { key: Buffer; cert: Buffer }>() }
}

function certificateForHost(authority: ReturnType<typeof createTestAuthority>, hostname: string) {
  const existing = authority.leaves.get(hostname)
  if (existing) return existing
  const directory = mkdtempSync(path.join(authority.privateDirectory, "leaf-"))
  const keyFile = path.join(directory, "leaf.key")
  const requestFile = path.join(directory, "leaf.csr")
  const certificateFile = path.join(directory, "leaf.pem")
  const extensionFile = path.join(directory, "leaf.ext")
  writeFileSync(extensionFile, `subjectAltName=DNS:${hostname}\n`)
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", requestFile, "-subj", `/CN=${hostname}`], { stdio: "ignore" })
  execFileSync("openssl", ["x509", "-req", "-in", requestFile, "-CA", authority.certificate, "-CAkey", authority.key, "-CAcreateserial", "-out", certificateFile, "-days", "1", "-extfile", extensionFile], { stdio: "ignore" })
  const leaf = { key: readFileSync(keyFile), cert: readFileSync(certificateFile) }
  authority.leaves.set(hostname, leaf)
  return leaf
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
  for (const tunnel of host.tunnels) tunnel.destroy()
  host.proxy.closeAllConnections()
  await new Promise<void>((resolve) => host.proxy.close(() => resolve()))
  await fs.rm(host.directory, { recursive: true, force: true })
}

export function createLocalBrokeringSandboxDriver(options: LocalBrokeringDriverOptions): SandboxDriver & { catalogEntry: typeof localBrokeringTestDriverCatalogEntry } {
  if (process.platform !== "darwin") throw new Error("local brokering test driver requires macOS sandbox-exec network policy")
  const authority = createTestAuthority(options.root)
  const hosts = new Map<string, Host>()
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin))
  const upstreams = new Map(Object.entries(options.upstreams ?? {}).map(([origin, upstream]) => {
    const parsed = new URL(origin)
    const destination = new URL(upstream)
    if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.port || destination.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname)) {
      throw new Error("local broker upstreams require exact HTTPS origins and loopback HTTP destinations")
    }
    return [parsed.origin, destination.origin] as const
  }))
  const directOrigins = [options.controlPlaneOrigin, options.relayOrigin].filter((origin): origin is string => origin !== undefined).map((origin) => new URL(origin))
  const directDestinations = directOrigins.map((url) => {
    if (!(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol))) {
      throw new Error("local brokering direct origins must use loopback HTTP")
    }
    return `localhost:${url.port || (url.protocol === "https:" ? "443" : "80")}`
  })

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
    async function forward(request: IncomingMessage, response: ServerResponse, targetUrl: URL, destination: URL) {
      try {
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
        const upstream = await fetch(destination, {
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
    }
    const proxy = createServer((request, response) => {
      try {
        const targetUrl = new URL(request.url ?? "")
        if (!allowedOrigins.has(targetUrl.origin)) throw new Error("destination_refused")
        void forward(request, response, targetUrl, targetUrl)
      } catch {
        response.writeHead(403).end("local sandbox egress refused")
      }
    })
    proxy.on("connect", (request, socket, head) => {
      const match = /^([a-z0-9.-]+):443$/i.exec(request.url ?? "")
      const hostname = match?.[1]?.toLowerCase()
      const origin = hostname ? `https://${hostname}` : undefined
      const destination = origin && upstreams.get(origin)
      if (!hostname || !destination || !host.secrets.some((secret) => secret.hosts.includes(hostname))) {
        socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n")
        return
      }
      const leaf = certificateForHost(authority, hostname)
      const secure = createHttpsServer(leaf, (innerRequest, innerResponse) => {
        const hostHeader = innerRequest.headers.host?.toLowerCase()
        if (hostHeader !== hostname && hostHeader !== `${hostname}:443`) {
          innerResponse.writeHead(403).end("local sandbox egress refused")
          return
        }
        const url = new URL(innerRequest.url ?? "", origin)
        if (url.origin !== origin) {
          innerResponse.writeHead(403).end("local sandbox egress refused")
          return
        }
        void forward(innerRequest, innerResponse, url, new URL(`${url.pathname}${url.search}`, destination))
      })
      secure.listen(0, "127.0.0.1", () => {
        const address = secure.address()
        if (!address || typeof address === "string") {
          socket.destroy(new Error("local TLS listener has no port"))
          return
        }
        const bridge = net.connect(address.port, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
            if (head.length) bridge.write(head)
            socket.pipe(bridge).pipe(socket)
            socket.resume()
          })
        })
        bridge.on("error", () => socket.destroy())
        socket.on("error", () => bridge.destroy())
        socket.on("close", () => {
          bridge.destroy()
          secure.close()
          host.tunnels.delete(socket)
        })
        host.tunnels.add(socket)
      })
    })
    proxy.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"))
    const host: Host = { directory, target, secrets: [...(input.secrets ?? [])], proxy, child: undefined, tunnels: new Set() }
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
        NO_PROXY: directOrigins.map((url) => url.host).join(","),
        no_proxy: directOrigins.map((url) => url.host).join(","),
        NODE_USE_ENV_PROXY: "1",
        NODE_EXTRA_CA_CERTS: authority.certificate,
      }
      for (const secret of host.secrets) {
        if (Object.values(env).some((value) => value.includes(secret.value))) throw new Error("brokered secret entered sandbox environment")
      }
      const networkPolicy = `(version 1) (allow default) (deny network-outbound) (deny file-read* (subpath ${JSON.stringify(authority.privateDirectory)})) (allow process-exec (literal "/bin/ps") (with no-sandbox)) ${[`localhost:${proxyPort}`, ...directDestinations].map((destination) => `(allow network-outbound (remote tcp ${JSON.stringify(destination)}))`).join(" ")}`
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
    catalogEntry: localBrokeringTestDriverCatalogEntry,
    ensureHost,
    resumeHost: ({ ensure }) => ensureHost(ensure),
    inspect: async (target) => hosts.get(target.workspaceId ?? "")?.target,
    touch: async () => {},
    stop,
    suspend: stop,
    destroy: stop,
  }
}
