import fs from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { forward, forwardUpgrade } from "../harness/proxy"
import { listenOnLoopback } from "../harness/ports"

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
  await listenOnLoopback(server, input.port)
  return {
    url: `http://127.0.0.1:${input.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
