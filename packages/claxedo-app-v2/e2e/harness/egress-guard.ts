import { createServer, type Server } from "node:http"
import type { Duplex } from "node:stream"

export type EgressAttempt = { method: string; target: string }

export const REFUSED_BACKGROUND_TARGETS: Record<string, string> = {
  "models.opencode.ai:443": "the embedded OpenCode engine refreshes its model snapshot at start and every 5 minutes; its bundled snapshot answers",
  "api2.cursor.sh:443": "the app's machine-logins read checks Cursor's login with Cursor's API; the stack holds no Cursor login",
  "chatgpt.com:443": "Codex 0.156 app-server start; the stack holds no ChatGPT login for it to carry",
  "github.com:443": "Codex 0.156 app-server start",
  "api.github.com:443": "Codex 0.156 app-server start",
}

export function unexpectedEgress(attempts: EgressAttempt[]) {
  return attempts.filter((attempt) => !(attempt.method === "CONNECT" && attempt.target in REFUSED_BACKGROUND_TARGETS))
}

export type EgressGuard = {
  url: string
  attempts: EgressAttempt[]
  close(): Promise<void>
}

const REFUSAL = "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"

export const LOOPBACK_HOSTS = "127.0.0.1,localhost,::1"

function refuseTunnel(socket: Duplex) {
  socket.once("error", () => socket.destroy())
  socket.end(REFUSAL)
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}

export async function startEgressGuard(port: number): Promise<EgressGuard> {
  const attempts: EgressAttempt[] = []
  const server = createServer((request, response) => {
    attempts.push({ method: request.method ?? "GET", target: request.url ?? "" })
    response.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("the e2e harness refuses every request that leaves the machine")
  })
  server.on("connect", (request, socket) => {
    attempts.push({ method: "CONNECT", target: request.url ?? "" })
    refuseTunnel(socket)
  })
  server.on("upgrade", (request, socket) => {
    attempts.push({ method: "UPGRADE", target: request.url ?? "" })
    refuseTunnel(socket)
  })
  await listen(server, port)
  return {
    url: `http://127.0.0.1:${port}`,
    attempts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export function egressProxyEnv(guardUrl: string): NodeJS.ProcessEnv {
  return {
    HTTP_PROXY: guardUrl,
    HTTPS_PROXY: guardUrl,
    ALL_PROXY: guardUrl,
    http_proxy: guardUrl,
    https_proxy: guardUrl,
    all_proxy: guardUrl,
    NO_PROXY: LOOPBACK_HOSTS,
    no_proxy: LOOPBACK_HOSTS,
    NODE_USE_ENV_PROXY: "1",
  }
}
