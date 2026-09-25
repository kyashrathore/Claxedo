import { request as forwardRequest, type IncomingMessage, type ServerResponse } from "node:http"
import net from "node:net"
import type { Duplex } from "node:stream"

function forwardedHeaders(request: IncomingMessage, target: URL) {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers[name] = value
  headers.host = target.host
  return headers
}

export function forward(request: IncomingMessage, response: ServerResponse, target: URL) {
  const upstream = forwardRequest(
    { host: target.hostname, port: target.port, method: request.method, path: request.url, headers: forwardedHeaders(request, target) },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(response)
    },
  )
  upstream.on("error", (error) => (response.headersSent ? response.destroy(error) : response.writeHead(502).end(error.message)))
  request.pipe(upstream)
}

export function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, target: URL) {
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const headers = Object.entries(forwardedHeaders(request, target)).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
    )
    upstream.write([`${request.method} ${request.url} HTTP/1.1`, ...headers, "", ""].join("\r\n"))
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
}
