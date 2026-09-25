import net from "node:net"

export type Proxy = { readonly url: string; readonly disconnect: () => void; readonly reconnect: () => void; readonly close: () => Promise<void> }

export function startTcpProxy(target: URL): Promise<Proxy> {
  const sockets = new Set<net.Socket>()
  let accepting = true
  const server = net.createServer((client) => {
    if (!accepting) return client.destroy()
    const upstream = net.connect(Number(target.port), target.hostname)
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      socket.on("error", () => [client, upstream].forEach((end) => end.destroy()))
    }
    client.pipe(upstream).pipe(client)
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        disconnect: () => {
          accepting = false
          for (const socket of sockets) socket.destroy()
        },
        reconnect: () => {
          accepting = true
        },
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}
