import { once } from "node:events"

export function attachHttpServerErrorHandlers(server) {
  server.on("clientError", (error, socket) => {
    if (error?.code === "ECONNRESET" || error?.code === "EPIPE") {
      socket.destroy()
      return
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
  })
  server.on("connection", (socket) => {
    socket.setKeepAlive(false)
    socket.on("error", (error) => {
      if (error?.code === "ECONNRESET" || error?.code === "EPIPE") return
      console.error("signed-browser-relay-fixture: socket error", error)
    })
  })
}

export async function closeHttp(server) {
  if (!server.listening) return
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    // Fixture teardown must not wait forever for an SSE connection whose
    // peer disappeared with the owning test process.
    server.closeAllConnections?.()
  })
}

export async function serverPort(server, label) {
  if (!server.listening) await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error(`${label} did not bind`)
  return address.port
}
