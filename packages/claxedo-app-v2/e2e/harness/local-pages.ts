import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { selfSignedCertificate } from "./tls-front"

export type LocalPages = { url: string; requested: readonly string[]; close(): Promise<void> }

export type LocalPagesOptions = { readonly held?: readonly string[]; readonly secure?: boolean }

export async function serveLocalPages(input: {
  pages: Readonly<Record<string, string>>
  held: readonly string[]
  secure: { certDir: string } | undefined
  port: number
}): Promise<LocalPages> {
  const requested: string[] = []
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://pages").pathname
    requested.push(path)
    if (input.held.includes(path)) return
    const body = input.pages[path]
    if (body === undefined) return void response.writeHead(404).end()
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body)
  }
  const server = input.secure ? createSecureServer(await selfSignedCertificate(input.secure.certDir), handle) : createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port, "127.0.0.1", resolve)
  })
  return {
    url: `${input.secure ? "https" : "http"}://127.0.0.1:${input.port}`,
    requested,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
