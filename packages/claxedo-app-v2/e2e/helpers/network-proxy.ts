import { createConnection, type Socket } from "node:net"
import { createServer, request } from "node:http"

/** A local HTTP proxy forwards real responses and drops established WebSockets during an outage. */
export async function startNetworkProxy(target: URL) {
  if (target.protocol !== "http:") throw new Error("The network fault proxy requires an HTTP target")
  const sockets = new Set<Socket>()
  let connected = true
  const server = createServer((incoming, outgoing) => {
    if (!connected) {
      incoming.socket.destroy()
      return
    }
    const url = new URL(incoming.url!, target)
    const upstream = request(target, {
      method: incoming.method,
      path: url.pathname + url.search,
      headers: incoming.headers,
    }, response => {
      outgoing.writeHead(response.statusCode!, response.headers)
      response.pipe(outgoing)
    })
    upstream.on("socket", socket => track(socket))
    upstream.on("error", () => outgoing.destroy())
    incoming.on("error", () => upstream.destroy())
    incoming.pipe(upstream)
  })
  const track = (socket: Socket) => {
    if (sockets.has(socket)) return
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  }
  server.on("connection", socket => {
    track(socket)
    if (!connected) socket.destroy()
  })
  server.on("connect", (incoming, client, head) => {
    if (!connected) {
      client.destroy()
      return
    }
    const destination = new URL(`http://${incoming.url}`)
    const upstream = createConnection({ host: destination.hostname, port: Number(destination.port || 80) })
    track(upstream)
    const close = () => { client.destroy(); upstream.destroy() }
    client.on("error", close)
    upstream.on("error", close)
    client.on("close", close)
    upstream.on("close", close)
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })
  server.on("upgrade", (incoming, client, head) => {
    if (!connected) {
      client.destroy()
      return
    }
    const url = new URL(incoming.url!, target)
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 80) })
    track(upstream)
    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on("error", close)
    upstream.on("error", close)
    client.on("close", close)
    upstream.on("close", close)
    upstream.on("connect", () => {
      upstream.write(`${incoming.method} ${url.pathname}${url.search} HTTP/${incoming.httpVersion}\r\n`)
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        upstream.write(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}\r\n`)
      }
      upstream.write("\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The network fault proxy has no TCP address")
  const disconnect = () => {
    connected = false
    for (const socket of sockets) socket.destroy()
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    disconnect,
    reconnect: () => { connected = true },
    close: async () => {
      disconnect()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
