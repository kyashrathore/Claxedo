import { createServer } from "node:http"

export type ConnectionSink = {
  url: string
  port: number
  connections: () => number
  close(): Promise<void>
}

export async function serveConnectionSink(port: number): Promise<ConnectionSink> {
  let connections = 0
  const server = createServer((_request, response) => response.writeHead(204).end())
  server.on("connection", () => {
    connections += 1
  })
  server.on("upgrade", (_request, socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
