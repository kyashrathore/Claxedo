import fs from "node:fs"
import { createServer, request as forwardRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import net from "node:net"
import path from "node:path"
import type { Duplex } from "node:stream"

export type AppOrigin = { url: string; close(): Promise<void> }

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
}

function fileFor(distDir: string, pathname: string) {
  const file = path.join(distDir, path.normalize(decodeURIComponent(pathname)))
  if (!file.startsWith(distDir + path.sep)) return undefined
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : undefined
}

function isDocument(request: IncomingMessage, pathname: string) {
  return request.method === "GET" && path.extname(pathname) === "" && (request.headers.accept ?? "").includes("text/html")
}

function sendFile(response: ServerResponse, file: string) {
  response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" })
  fs.createReadStream(file).pipe(response)
}

function forwardedHeaders(request: IncomingMessage, daemon: URL) {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers[name] = value
  headers.host = daemon.host
  return headers
}

function forward(request: IncomingMessage, response: ServerResponse, daemon: URL) {
  const upstream = forwardRequest(
    { host: daemon.hostname, port: daemon.port, method: request.method, path: request.url, headers: forwardedHeaders(request, daemon) },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(response)
    },
  )
  upstream.on("error", (error) => (response.headersSent ? response.destroy(error) : response.writeHead(502).end(error.message)))
  request.pipe(upstream)
}

function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, daemon: URL) {
  const upstream = net.connect(Number(daemon.port), daemon.hostname, () => {
    const headers = Object.entries(forwardedHeaders(request, daemon)).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
    )
    upstream.write([`${request.method} ${request.url} HTTP/1.1`, ...headers, "", ""].join("\r\n"))
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
}

function listen(server: Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}

export async function startAppOrigin(input: { port: number; distDir: string; daemonUrl: string }): Promise<AppOrigin> {
  const daemon = new URL(input.daemonUrl)
  const index = path.join(input.distDir, "index.html")
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://origin").pathname
    const file = fileFor(input.distDir, pathname)
    if (file) return sendFile(response, file)
    if (isDocument(request, pathname)) return sendFile(response, index)
    forward(request, response, daemon)
  })
  server.on("upgrade", (request, socket, head) => forwardUpgrade(request, socket, head, daemon))
  await listen(server, input.port)
  return {
    url: `http://127.0.0.1:${input.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
