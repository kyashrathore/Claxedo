import { spawn, type ChildProcess } from "child_process"
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

export type ACPTransportEnv = Record<string, string | undefined>

export type ACPTransport = {
  kind: "stdio" | "streamable-http" | "websocket"
  stream: Stream
  metadata: Record<string, unknown>
  pid?: number | null
  alive: boolean
  dispose(): void
}

export type ACPTransportFactoryInput = {
  directory: string
  binary: string
  args: string[]
  model: string
  env: ACPTransportEnv
  onStderr: (text: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  onError: (err: Error) => void
}

export type ACPTransportFactory = (input: ACPTransportFactoryInput) => ACPTransport

export type ACPStreamableHttpTransportFactoryOptions = {
  serverUrl: string
  fetch?: HttpStreamOptions["fetch"]
  headers?: Record<string, string>
  cookies?: HttpStreamOptions["cookies"]
  cookieStore?: AcpCookieStore
}
export type ACPHttpTransportFactoryOptions = ACPStreamableHttpTransportFactoryOptions

export type ACPWebSocketTransportFactoryOptions = {
  serverUrl: string
  protocols?: WebSocketStreamOptions["protocols"]
  headers?: Record<string, string>
  WebSocket?: WebSocketStreamOptions["WebSocket"]
  cookies?: WebSocketStreamOptions["cookies"]
  cookieStore?: AcpCookieStore
}

export function createStdioACPTransport(input: ACPTransportFactoryInput): ACPTransport {
  const proc = spawn(input.binary, input.args, {
    cwd: input.directory,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...definedEnv(input.env),
    },
  })

  proc.stderr?.on("data", (data: Buffer) => {
    input.onStderr(data.toString().trim())
  })
  proc.on("exit", input.onExit)
  proc.on("error", input.onError)

  return {
    kind: "stdio",
    stream: ndJsonStream(webWritable(proc), webReadable(proc)),
    metadata: {
      binary: input.binary,
      args: input.args,
      directory: input.directory,
      model: input.model,
      command: input.binary,
      commandArgs: input.args,
    },
    get pid() {
      return proc.pid ?? null
    },
    get alive() {
      return proc.exitCode === null && !proc.killed
    },
    dispose() {
      try {
        proc.kill("SIGTERM")
      } catch {}
    },
  }
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

export const createHttpACPTransportFactory = createStreamableHttpACPTransportFactory

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

function definedEnv(env: ACPTransportEnv) {
  return Object.fromEntries(
    Object.entries(env).filter((item): item is [string, string] => typeof item[1] === "string" && item[1].length > 0),
  )
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
