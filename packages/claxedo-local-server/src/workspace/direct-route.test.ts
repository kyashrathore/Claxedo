import { afterEach, describe, expect, test } from "vitest"
import { createHash } from "node:crypto"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { createServer as createTlsServer, type Server as TlsServer } from "node:https"
import { connect } from "node:net"
import os from "node:os"
import { Hono } from "hono"
import { getRequestListener } from "@hono/node-server"
import { createDirectTlsKey, directTlsIdentity, type DirectTlsIdentity } from "@claxedo/host-serving/direct-certificate"
import { privateNetworkAddresses } from "@claxedo/host-serving/direct-listener"
import { DirectRouteUnreachable, pinnedConnection } from "./direct-connection"
import { createDirectRouteCarrier } from "./direct-route"

const lanAddress = privateNetworkAddresses()[0]
const onLan = test.skipIf(!lanAddress)
const TOKEN = "header.payload.signature"
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

function listening(server: Server | TlsServer, host: string) {
  return new Promise<number>((resolve) => {
    server.listen(0, host, () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      closers.push(() => new Promise((done) => {
        server.close(() => done())
        server.closeAllConnections()
      }))
      resolve(address.port)
    })
  })
}

type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders }

async function machine(identity: DirectTlsIdentity, host = lanAddress!) {
  const seen: Seen[] = []
  const connections = { count: 0 }
  const server = createTlsServer({ key: identity.keyPem, cert: identity.certPem }, (request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers })
    let body = ""
    request.on("data", (chunk: Buffer) => { body += chunk.toString() })
    request.on("end", () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: request.url, body })))
  })
  server.on("connection", () => { connections.count++ })
  server.on("upgrade", (request, socket) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers })
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.pipe(socket)
  })
  const port = await listening(server, host)
  return { port, seen, connections, routes: { port, addresses: [host], spkiSha256: identity.spkiSha256 }, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() }) }
}

async function daemon(interfaces: () => ReturnType<typeof os.networkInterfaces> = () => os.networkInterfaces()) {
  const direct = createDirectRouteCarrier({ interfaces })
  const app = new Hono()
  app.put("/api/claxedo/direct-routes/:workspaceId", direct.register)
  app.all("/direct/workspaces/:workspaceId/*", direct.route)
  const server = createServer(getRequestListener(app.fetch))
  direct.injectWebSocket(server, app, createServer())
  const origin = `http://127.0.0.1:${await listening(server, "127.0.0.1")}`
  const register = (workspaceId: string, routes: unknown) => fetch(`${origin}/api/claxedo/direct-routes/${workspaceId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(routes) })
  return { origin, register, port: Number(new URL(origin).port) }
}

const code = async (response: Response) => ((await response.json()) as { error?: { code?: string } }).error?.code

describe("the pinned connection", () => {
  test("is refused by a machine presenting another key, before anything is written", async () => {
    const presented = await directTlsIdentity(await createDirectTlsKey())
    const reported = await directTlsIdentity(await createDirectTlsKey())
    const fake = await machine(presented, "127.0.0.1")

    await expect(pinnedConnection({ address: "127.0.0.1", port: fake.port, spkiSha256: reported.spkiSha256 }, 1_000)).rejects.toBeInstanceOf(DirectRouteUnreachable)
    const accepted = await pinnedConnection({ address: "127.0.0.1", port: fake.port, spkiSha256: presented.spkiSha256 }, 1_000)
    accepted.destroy()
    expect(fake.seen).toEqual([])
  })
})

describe("the daemon's direct route", () => {
  onLan("carries a request to the machine with the runtime access token and none of the renderer's own headers", async () => {
    const fake = await machine(await directTlsIdentity(await createDirectTlsKey()))
    const { origin, register } = await daemon()

    const registered = await register("ws_1", fake.routes)
    expect(await registered.json()).toEqual({ address: lanAddress })
    const answer = await fetch(`${origin}/direct/workspaces/ws_1/api/wr/pty?cursor=3`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, cookie: "session=1", origin: "http://localhost:5173", "x-claxedo-daemon-capability": "secret", "content-type": "application/json" },
      body: JSON.stringify({ title: "shell" }),
    })

    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ url: "/workspaces/ws_1/api/wr/pty?cursor=3", body: "{\"title\":\"shell\"}" })
    const headers = fake.seen.at(-1)?.headers ?? {}
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect([headers.cookie, headers.origin, headers["x-claxedo-daemon-capability"]]).toEqual([undefined, undefined, undefined])
  })

  onLan("answers direct_route_unavailable at once for a workspace with no routes, a machine presenting another key, and a machine that went away", async () => {
    const fake = await machine(await directTlsIdentity(await createDirectTlsKey()))
    const { origin, register } = await daemon()
    const call = (workspaceId: string) => fetch(`${origin}/direct/workspaces/${workspaceId}/session`, { headers: { authorization: `Bearer ${TOKEN}` } })

    expect([(await call("ws_unknown")).status, await code(await call("ws_unknown"))]).toEqual([503, "direct_route_unavailable"])
    const impostor = await register("ws_impostor", { ...fake.routes, spkiSha256: (await directTlsIdentity(await createDirectTlsKey())).spkiSha256 })
    expect([impostor.status, await code(impostor)]).toEqual([503, "direct_route_unavailable"])
    expect(await code(await call("ws_impostor"))).toBe("direct_route_unavailable")

    expect((await register("ws_1", fake.routes)).status).toBe(200)
    expect((await call("ws_1")).status).toBe(200)
    await fake.close()
    const gone = await call("ws_1")
    expect([gone.status, await code(gone)]).toEqual([503, "direct_route_unavailable"])
    expect(fake.seen.every((request) => request.url?.startsWith("/workspaces/ws_1"))).toBe(true)
  })

  onLan("refuses routes that name an address no machine on this network could hold", async () => {
    const { register } = await daemon()
    for (const addresses of [["8.8.8.8"], ["127.0.0.1"], ["fe80::1"], []]) {
      const refused = await register("ws_1", { port: 4433, addresses, spkiSha256: "A".repeat(43) })
      expect([refused.status, await code(refused)]).toEqual([400, "direct_routes_invalid"])
    }
  })

  onLan("keeps the address that answered until the network changes, then asks again", async () => {
    const fake = await machine(await directTlsIdentity(await createDirectTlsKey()))
    let interfaces = os.networkInterfaces()
    const { origin, register } = await daemon(() => interfaces)
    const call = () => fetch(`${origin}/direct/workspaces/ws_1/session`, { headers: { authorization: `Bearer ${TOKEN}` } })

    await register("ws_1", fake.routes)
    const before = fake.connections.count
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    expect(fake.connections.count - before).toBe(1)
    interfaces = { ...interfaces, wlan9: [{ address: "10.255.255.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "10.255.255.1/8" }] }
    expect((await call()).status).toBe(200)
    expect(fake.connections.count - before).toBe(2)
  })

  onLan("carries a terminal's WebSocket byte for byte, the token moved from the subprotocol to the bearer and echoed back as the chosen protocol", async () => {
    const fake = await machine(await directTlsIdentity(await createDirectTlsKey()))
    const { register, port } = await daemon()
    await register("ws_1", fake.routes)

    const echoed = await new Promise<{ head: string; echo: string }>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /direct/workspaces/ws_1/api/wr/pty/pty_1/connect?cursor=0 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
          + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: claxedo-rat.${TOKEN}\r\n\r\n`,
        )
      })
      let received = ""
      let head = ""
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString()
        if (!head && received.includes("\r\n\r\n")) {
          head = received.slice(0, received.indexOf("\r\n\r\n"))
          received = received.slice(head.length + 4)
          socket.write("keystroke")
        }
        if (head && received === "keystroke") {
          socket.destroy()
          resolve({ head, echo: received })
        }
      })
      socket.on("error", reject)
    })

    expect(echoed.head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols")
    expect(echoed.head).toContain(`Sec-WebSocket-Protocol: claxedo-rat.${TOKEN}`)
    expect(echoed.echo).toBe("keystroke")
    const upgrade = fake.seen.at(-1)
    expect(upgrade?.url).toBe("/workspaces/ws_1/api/wr/pty/pty_1/connect?cursor=0")
    expect(upgrade?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(upgrade?.headers["sec-websocket-protocol"]).toBeUndefined()
  })
})
