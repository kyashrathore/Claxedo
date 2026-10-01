import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer, request as httpsRequest } from "node:https"
import { X509Certificate, createHash } from "node:crypto"
import fs from "node:fs/promises"
import { appBundleFile } from "../../../harness/e2e/harness/local-app-bundle"
import { listenOnLoopback } from "../../../harness/e2e/harness/ports"
import type { HostedStack } from "../../../harness/e2e/harness/hosted-flow"
import type { TlsFront } from "./tls-front"

export async function startHostedAppFront(input: { port: number; distDir: string; hosted: HostedStack }): Promise<TlsFront & { controlPlaneRequests(): readonly string[] }> {
  const certificate = await fs.readFile(input.hosted.certificate)
  const worker = new URL(input.hosted.workerOrigin)
  const tls = { cert: certificate, key: await fs.readFile(input.hosted.credentials.key) }
  const forwarded: string[] = []
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", input.hosted.workerUrl).pathname
    if (/^\/(api|auth|internal|\.well-known)(\/|$)/.test(pathname) || pathname === "/health") {
      forwarded.push(`${request.method} ${pathname}`)
      const upstream = httpsRequest({ hostname: worker.hostname, port: worker.port, method: request.method,
        path: request.url, headers: request.headers, ca: certificate }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
      })
      upstream.on("error", (error) => response.headersSent ? response.destroy(error) : response.writeHead(502).end(error.message))
      request.pipe(upstream)
      return
    }
    const asset = await appBundleFile(input.distDir, pathname, request.headers.accept?.includes("text/html") ?? false)
    if (!asset) { response.writeHead(404).end(); return }
    response.writeHead(asset.status, Object.fromEntries(asset.headers)).end(Buffer.from(await asset.arrayBuffer()))
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
    controlPlaneRequests: () => [...forwarded],
    trust: { caPath: input.hosted.certificate, spki: createHash("sha256").update(spki).digest("base64") },
    close: async () => {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    },
  }
}
