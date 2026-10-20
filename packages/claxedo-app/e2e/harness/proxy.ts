import type { Http2ServerRequest } from "node:http2"
import { request as forwardRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders } from "node:http"
import net from "node:net"
import type { Duplex, Writable } from "node:stream"

export type FrontRequest = IncomingMessage | Http2ServerRequest
export type FrontResponse = Writable & {
  readonly headersSent: boolean
  writeHead(status: number, headers?: OutgoingHttpHeaders): Writable
}

const CONNECTION_HEADERS = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]

export function forwardedHeaders(request: FrontRequest, host: string = request.headers.host ?? request.headers[":authority"] as string) {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined && !name.startsWith(":")) headers[name] = value
  headers.host = host
  return headers
}

export function answerHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const answer: OutgoingHttpHeaders = { ...headers }
  for (const name of CONNECTION_HEADERS) delete answer[name]
  return answer
}

export function abortResponse(response: FrontResponse, error: Error) {
  if (response.headersSent) response.destroy(error)
  else response.writeHead(502).end(error.message)
}

export function forward(request: FrontRequest, response: FrontResponse, target: URL) {
  const upstream = forwardRequest(
    { host: target.hostname, port: target.port, method: request.method, path: request.url, headers: forwardedHeaders(request, target.host) },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, answerHeaders(reply.headers))
      reply.pipe(response)
    },
  )
  upstream.on("error", (error) => abortResponse(response, error))
  response.on("close", () => upstream.destroy())
  request.pipe(upstream)
}

export function forwardUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, target: URL) {
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const headers = Object.entries(forwardedHeaders(request, target.host)).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`),
    )
    upstream.write([`${request.method} ${request.url} HTTP/1.1`, ...headers, "", ""].join("\r\n"))
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
}
