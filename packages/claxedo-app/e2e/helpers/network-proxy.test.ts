import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { createConnection, type Socket } from "node:net"
import { once } from "node:events"
import { startNetworkProxy } from "./network-proxy"

test("network outages close established tunnels and preserve the upstream server for recovery", async () => {
  const upstream = createServer((_request, response) => response.end("upstream body"))
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("Upstream has no TCP address")
  const target = new URL(`http://127.0.0.1:${address.port}`)
  const network = await startNetworkProxy(target)
  const connect = async () => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(network.url).port) })
    await once(socket, "connect")
    const reply = once(socket, "data")
    socket.write(`CONNECT ${target.host} HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`)
    expect((await reply)[0].toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n")
    return socket
  }
  const request = async (socket: Socket) => {
    const reply = once(socket, "data")
    socket.write(`GET / HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`)
    expect((await reply)[0].toString()).toContain("upstream body")
  }
  let socket: Socket | undefined
  try {
    socket = await connect()
    await request(socket)
    const closed = once(socket, "close")
    network.disconnect()
    await closed
    expect(socket.destroyed).toBe(true)
    const rejected = createConnection({ host: "127.0.0.1", port: Number(new URL(network.url).port) })
    rejected.on("error", () => {})
    rejected.resume()
    rejected.end("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
    await new Promise<void>(resolve => rejected.on("close", () => resolve()))
    expect(rejected.destroyed).toBe(true)
    const direct = createConnection({ host: "127.0.0.1", port: address.port })
    await once(direct, "connect")
    try { await request(direct) } finally { direct.destroy() }
    network.reconnect()
    socket = await connect()
    await request(socket)
  } finally {
    socket?.destroy()
    await network.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
