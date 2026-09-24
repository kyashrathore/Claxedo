import { createServer } from "node:http"

export type LocalPages = { url: string; requested: readonly string[]; close(): Promise<void> }

export async function serveLocalPages(input: { pages: Readonly<Record<string, string>>; port: number }): Promise<LocalPages> {
  const requested: string[] = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://pages").pathname
    requested.push(path)
    const body = input.pages[path]
    if (body === undefined) return void response.writeHead(404).end()
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(input.port, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${input.port}`,
    requested,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
