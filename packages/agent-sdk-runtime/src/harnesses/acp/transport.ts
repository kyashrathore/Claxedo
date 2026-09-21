import { asRecord } from "@claxedo/agent-runtime-contract"
import { spawn, type ChildProcess } from "child_process"
import { killHarnessProcess, drainHarnessProcessGroup, resolveHarnessCommand } from "../shared/windows-process"
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk"
import {
  createHttpStream,
  type AcpCookieStore,
  type HttpStreamOptions,
} from "@agentclientprotocol/sdk/experimental/http-client"
import {
  createWebSocketStream,
  type WebSocketStreamOptions,
} from "@agentclientprotocol/sdk/experimental/ws-client"
import { harnessSpawnEnv } from "../shared/spawn-env"

export type ACPTransportEnv = Record<string, string | undefined>

export type ACPTransport = {
  kind: "stdio" | "streamable-http" | "websocket"
  stream: Stream
  /** Explicit operator assertion that the agent can read this workspace. */
  sharedFilesystem?: boolean
  metadata: Record<string, unknown>
  pid?: number | null
  alive: boolean
  dispose(): void | Promise<void>
}

export type ACPTransportFactoryInput = {
  directory: string
  command?: string
  args: string[]
  model: string
  env: ACPTransportEnv
  onStderr: (text: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  onError: (err: Error) => void
}

export type ACPTransportFactory = (input: ACPTransportFactoryInput) => ACPTransport

export type ACPProcessConnection = {
  kind: "process"
  command: string
  args?: string[]
  env?: ACPTransportEnv
  supportsMcpServers?: boolean
  sharedFilesystem?: boolean
}

export type ACPStreamableHttpConnection = {
  kind: "streamable-http"
  url: string
  headers?: Record<string, string>
  supportsMcpServers?: boolean
  sharedFilesystem?: boolean
}

export type ACPWebSocketConnection = {
  kind: "websocket"
  url: string
  protocols?: string[]
  headers?: Record<string, string>
  supportsMcpServers?: boolean
  sharedFilesystem?: boolean
}

export type ACPConnection = ACPProcessConnection | ACPStreamableHttpConnection | ACPWebSocketConnection

// Retirement outlives adapter instances. A replacement must not race an old
// wrapper's descendants that still own the agent's backing session storage.
const retiring = new Map<string, Set<Promise<void>>>()
function launchIdentity(directory: string, command: string, args: string[]) {
  return JSON.stringify([directory, command, args])
}
export async function waitForACPTransportRetirement(directory: string, connection: ACPConnection) {
  if (connection.kind !== "process") return
  const key = launchIdentity(directory, connection.command, connection.args ?? [])
  while (retiring.get(key)?.size) await Promise.all(retiring.get(key)!)
}

export function validateACPConnection(input: unknown): ACPConnection {
  const row = asRecord(input)
  if (!row) throw new Error("connection must be an object")
  const sharedFilesystem = optionalBoolean(row.sharedFilesystem, "sharedFilesystem")
  const supportsMcpServers = optionalBoolean(row.supportsMcpServers, "supportsMcpServers")
  if (row.kind === "process") {
    requireOnlyFields(row, ["kind", "command", "args", "env", "supportsMcpServers", "sharedFilesystem"])
    if (typeof row.command !== "string" || row.command.length === 0) throw new Error("process connection requires command")
    return {
      kind: "process",
      command: row.command,
      ...(stringArray(row.args, "args") ? { args: stringArray(row.args, "args") } : {}),
      ...(stringRecord(row.env, "env") ? { env: stringRecord(row.env, "env") } : {}),
      ...(supportsMcpServers !== undefined ? { supportsMcpServers } : {}),
      ...(sharedFilesystem !== undefined ? { sharedFilesystem } : {}),
    }
  }
  if (row.kind === "streamable-http") {
    requireOnlyFields(row, ["kind", "url", "headers", "supportsMcpServers", "sharedFilesystem"])
    if (typeof row.url !== "string" || row.url.length === 0) throw new Error("streamable-http connection requires url")
    requireUrlProtocol(row.url, ["http:", "https:"], "streamable-http")
    return {
      kind: "streamable-http",
      url: row.url,
      ...(stringRecord(row.headers, "headers") ? { headers: stringRecord(row.headers, "headers") } : {}),
      ...(supportsMcpServers !== undefined ? { supportsMcpServers } : {}),
      ...(sharedFilesystem !== undefined ? { sharedFilesystem } : {}),
    }
  }
  if (row.kind === "websocket") {
    requireOnlyFields(row, ["kind", "url", "protocols", "headers", "supportsMcpServers", "sharedFilesystem"])
    if (typeof row.url !== "string" || row.url.length === 0) throw new Error("websocket connection requires url")
    requireUrlProtocol(row.url, ["ws:", "wss:"], "websocket")
    return {
      kind: "websocket",
      url: row.url,
      ...(stringArray(row.protocols, "protocols") ? { protocols: stringArray(row.protocols, "protocols") } : {}),
      ...(stringRecord(row.headers, "headers") ? { headers: stringRecord(row.headers, "headers") } : {}),
      ...(supportsMcpServers !== undefined ? { supportsMcpServers } : {}),
      ...(sharedFilesystem !== undefined ? { sharedFilesystem } : {}),
    }
  }
  throw new Error("connection kind must be process, streamable-http, or websocket")
}

export type ACPStreamableHttpTransportFactoryOptions = {
  serverUrl: string
  fetch?: HttpStreamOptions["fetch"]
  headers?: Record<string, string>
  cookies?: HttpStreamOptions["cookies"]
  cookieStore?: AcpCookieStore
}

export type ACPWebSocketTransportFactoryOptions = {
  serverUrl: string
  protocols?: WebSocketStreamOptions["protocols"]
  headers?: Record<string, string>
  WebSocket?: WebSocketStreamOptions["WebSocket"]
  cookies?: WebSocketStreamOptions["cookies"]
  cookieStore?: AcpCookieStore
}

export function createStdioACPTransport(input: ACPTransportFactoryInput): ACPTransport {
  if (!input.command) throw new Error("ACP process transport requires a command")
  const env = acpSpawnEnv({
    ...process.env,
    ...definedEnv(input.env),
  })
  // A .cmd/.bat command is resolved to the executable it wraps rather than
  // routed through cmd.exe, so configured arguments stay literal argv entries.
  const launch = resolveHarnessCommand(input.command, input.args, env, input.directory)
  const proc = spawn(launch.command, launch.args, {
    cwd: input.directory,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env,
  })

  proc.stderr?.on("data", (data: Buffer) => {
    input.onStderr(data.toString().trim())
  })
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => { resolveExit = resolve })
  let retirement: Promise<void> | undefined
  const retire = () => {
    if (retirement) return retirement
    const key = launchIdentity(input.directory, input.command!, input.args)
    retirement = (async () => {
      const killer = process.platform === "win32" ? killHarnessProcess(proc, "SIGTERM", true) : undefined
      const tree = killer ? new Promise<void>((resolve, reject) => {
        killer.once("error", reject)
        killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ACP process-tree termination failed (${code})`)))
      }) : drainHarnessProcessGroup(proc, 5_000)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all([exited, tree]),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ACP process-tree termination timed out")), 5_000) }),
        ])
      } finally { if (timer) clearTimeout(timer) }
    })()
    const pending = retiring.get(key) ?? new Set<Promise<void>>()
    pending.add(retirement)
    retiring.set(key, pending)
    // Failed retirement remains a fence: never pretend a still-owned writer
    // was released. Attach the rejection handler even for synchronous dispose.
    void retirement.then(() => {
      pending.delete(retirement!)
      if (!pending.size) retiring.delete(key)
    }, () => {})
    return retirement
  }
  proc.on("exit", (code, signal) => { resolveExit(); retire(); input.onExit(code, signal) })
  proc.on("error", (error) => { resolveExit(); retire(); input.onError(error) })

  return {
    kind: "stdio",
    stream: ndJsonStream(webWritable(proc), webReadable(proc)),
    metadata: {
      args: input.args,
      directory: input.directory,
      model: input.model,
      command: input.command,
      commandArgs: input.args,
    },
    get pid() {
      return proc.pid ?? null
    },
    get alive() {
      return proc.exitCode === null && !proc.killed
    },
    dispose() {
      return retire()
    },
  }
}

export function acpSpawnEnv(input: ACPTransportEnv) {
  return harnessSpawnEnv(input)
}

export function createStreamableHttpACPTransportFactory(options: ACPStreamableHttpTransportFactoryOptions): ACPTransportFactory {
  return () => {
    const stream = createHttpStream(options.serverUrl, {
      fetch: options.fetch,
      headers: options.headers,
      cookies: options.cookies,
      cookieStore: options.cookieStore,
    })
    return remoteTransport("streamable-http", stream, options.serverUrl, options.headers)
  }
}

export function createWebSocketACPTransportFactory(options: ACPWebSocketTransportFactoryOptions): ACPTransportFactory {
  return () => {
    const stream = createWebSocketStream(options.serverUrl, {
      protocols: options.protocols,
      headers: options.headers,
      WebSocket: options.WebSocket,
      cookies: options.cookies,
      cookieStore: options.cookieStore,
    })
    return remoteTransport("websocket", stream, options.serverUrl, options.headers)
  }
}

export function createACPTransportFactory(connection: ACPConnection): ACPTransportFactory {
  const factory = connectionTransportFactory(connection)
  return (input) => {
    const transport = factory(input)
    transport.sharedFilesystem = connection.sharedFilesystem === true
    return transport
  }
}

function connectionTransportFactory(connection: ACPConnection): ACPTransportFactory {
  switch (connection.kind) {
    case "process":
      return createStdioACPTransport
    case "streamable-http":
      return createStreamableHttpACPTransportFactory({
        serverUrl: connection.url,
        headers: connection.headers,
      })
    case "websocket":
      return createWebSocketACPTransportFactory({
        serverUrl: connection.url,
        protocols: connection.protocols,
        headers: connection.headers,
      })
    default:
      throw new Error(`Unknown ACP connection kind: ${JSON.stringify(connection)}`)
  }
}

function definedEnv(env: ACPTransportEnv) {
  return Object.fromEntries(
    Object.entries(env).filter((item): item is [string, string] => typeof item[1] === "string" && item[1].length > 0),
  )
}

function optionalBoolean(input: unknown, field: string) {
  if (input === undefined) return undefined
  if (typeof input !== "boolean") throw new Error(`${field} must be boolean`)
  return input
}

function stringArray(input: unknown, field: string): string[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`)
  return input
}

function stringRecord(input: unknown, field: string): Record<string, string> | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${field} must be a string record`)
  const entries = Object.entries(input)
  if (entries.some(([, value]) => typeof value !== "string")) throw new Error(`${field} must be a string record`)
  return Object.fromEntries(entries) as Record<string, string>
}

function requireOnlyFields(input: Record<string, unknown>, allowed: readonly string[]) {
  const extra = Object.keys(input).find((key) => !allowed.includes(key))
  if (extra) throw new Error(`${String(input.kind)} connection cannot include ${extra}`)
}

function requireUrlProtocol(input: string, protocols: readonly string[], kind: string) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(`${kind} connection requires a valid URL`)
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${kind} connection URL uses an unsupported protocol`)
}

function remoteTransport(
  kind: "streamable-http" | "websocket",
  stream: Stream,
  serverUrl: string,
  headers?: Record<string, string>,
): ACPTransport {
  let alive = true
  return {
    kind,
    stream,
    metadata: {
      serverUrl,
      headerNames: Object.keys(headers ?? {}),
    },
    pid: null,
    get alive() {
      return alive
    },
    dispose() {
      alive = false
      void stream.writable.close().catch(() => {})
    },
  }
}

function webWritable(proc: ChildProcess) {
  const stdin = proc.stdin!
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        stdin.write(chunk, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
    close() {
      stdin.end()
    },
  })
}

function webReadable(proc: ChildProcess) {
  const stdout = proc.stdout!
  let closed = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const data = (chunk: Buffer) => {
        if (closed) return
        try {
          controller.enqueue(new Uint8Array(chunk))
        } catch {
          closed = true
        }
      }
      const end = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {}
      }
      const error = (err: Error) => {
        if (closed) return
        closed = true
        try {
          controller.error(err)
        } catch {}
      }
      stdout.on("data", data)
      stdout.on("end", end)
      stdout.on("error", error)
    },
  })
}
