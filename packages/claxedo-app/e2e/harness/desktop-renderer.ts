import fs from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { DESKTOP_DIR } from "./desktop-build"

export type DesktopRenderer = "file" | "http"

export type RendererServer = { url: string; close(): Promise<void> }

const RENDERER_DIR = path.join(DESKTOP_DIR, "out/renderer")

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
}

async function serveFile(request: IncomingMessage, response: ServerResponse) {
  const file = path.join(RENDERER_DIR, decodeURIComponent(new URL(request.url ?? "/", "http://renderer").pathname))
  if (!file.startsWith(`${RENDERER_DIR}${path.sep}`)) return void response.writeHead(403).end()
  const body = await fs.readFile(file).catch(() => undefined)
  if (!body) return void response.writeHead(404).end()
  response.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body)
}

export async function serveRenderer(port: number): Promise<RendererServer> {
  const server = createServer((request, response) => void serveFile(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
