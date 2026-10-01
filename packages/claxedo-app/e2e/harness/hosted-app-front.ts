import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer, request as httpsRequest } from "node:https"
import { X509Certificate, createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { listenOnLoopback } from "../../../harness/e2e/harness/ports"
import type { HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import type { TlsFront } from "./tls-front"

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" }

export async function startHostedAppFront(input: { port: number; distDir: string; hosted: HostedStack }): Promise<TlsFront> {
  const certificate = await fs.readFile(input.hosted.certificate)
  const root = path.resolve(input.distDir)
  const worker = new URL(input.hosted.workerOrigin)
  const tls = { cert: certificate, key: await fs.readFile(input.hosted.credentials.key) }
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", input.hosted.workerUrl).pathname
    if (/^\/(api|auth|internal|\.well-known)(\/|$)/.test(pathname) || pathname === "/health") {
      const upstream = httpsRequest({ hostname: worker.hostname, port: worker.port, method: request.method,
        path: request.url, headers: request.headers, ca: certificate }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
      })
      upstream.on("error", (error) => response.headersSent ? response.destroy(error) : response.writeHead(502).end(error.message))
      request.pipe(upstream)
      return
    }
    try {
      const file = path.resolve(root, `.${decodeURIComponent(pathname)}`)
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return }
      const asset = path.extname(file) ? file : path.join(root, "index.html")
      const contents = await fs.readFile(asset)
      response.writeHead(200, { "content-type": TYPES[path.extname(asset)] ?? "application/octet-stream" }).end(contents)
    } catch (error) {
      response.writeHead((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500).end()
    }
  }
  // The public origin is a *.localhost name, which resolvers answer with ::1
  // before 127.0.0.1; workerd and the sandbox runtimes take the first answer.
  const servers = [createServer(tls, serve), createServer(tls, serve)]
  await listenOnLoopback(servers[0], input.port)
  await new Promise<void>((resolve, reject) => {
    servers[1].once("error", reject)
    servers[1].listen(input.port, "::1", resolve)
  })
  const spki = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" })
  return {
    url: input.hosted.workerUrl,
    trust: { caPath: input.hosted.certificate, spki: createHash("sha256").update(spki).digest("base64") },
    close: async () => {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    },
  }
}
