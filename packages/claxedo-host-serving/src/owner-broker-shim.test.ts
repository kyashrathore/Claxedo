import { afterEach, describe, expect, test } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { connect } from "node:net"
import { projectRuntimeAuth } from "@claxedo/server-core/agent-config/index"
import { startOwnerBrokerShim, type OwnerBrokerShim } from "./owner-broker-shim"
import type { OwnerBrokerChannels, OwnerBrokerRequest } from "./owner-broker-channel"
import { adoptConnectedHostOwner, installHostProviderConfigAuthority, setHostProviderConfig } from "./runtime"
import { resetHostEnrolledOwner } from "./serving"

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

type Seen = { url: string; headers: IncomingHttpHeaders; body: string }

async function hostedBroker() {
  const seen: Seen[] = []
  const server: Server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => { body += chunk.toString() })
    request.on("end", () => {
      seen.push({ url: request.url ?? "/", headers: request.headers, body })
      response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_hosted" })
      response.end("event: message_stop\ndata: {}\n\n")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { seen, url: `http://127.0.0.1:${address.port}` }
}

function channel(offered: string[], answer: (request: OwnerBrokerRequest) => Promise<Response | undefined>) {
  const forwarded: OwnerBrokerRequest[] = []
  const channels: Pick<OwnerBrokerChannels, "offers" | "forward"> = {
    offers: (providerId) => offered.includes(providerId),
    forward: async (request) => {
      forwarded.push(request)
      return await answer(request)
    },
  }
  return { channels, forwarded }
}

async function shim(channels: Pick<OwnerBrokerChannels, "offers" | "forward">, port?: number): Promise<OwnerBrokerShim> {
  const started = await startOwnerBrokerShim({ channels, ...(port === undefined ? {} : { port }) })
  closers.push(() => started.close())
  return started
}

const send = (baseUrl: string, standIn: string, headers: Record<string, string> = {}) => fetch(`${baseUrl}/v1/messages?beta=true`, {
  method: "POST",
  headers: { "x-api-key": standIn, "content-type": "application/json", ...headers },
  body: JSON.stringify({ messages: [] }),
})

describe("the owner broker shim in front of the rows built from the owner's accounts", () => {
  test("with no desktop serving the provider, a call goes to its row's hosted binding untouched, stand-in included", async () => {
    const hosted = await hostedBroker()
    const { channels, forwarded } = channel([], async () => undefined)
    const front = await shim(channels)
    const baseUrl = front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in" })

    const answer = await send(baseUrl, "stand-in")

    expect(answer.status).toBe(200)
    expect(answer.headers.get("x-request-id")).toBe("req_hosted")
    expect(await answer.text()).toContain("message_stop")
    expect(hosted.seen.map((entry) => [entry.url, entry.headers["x-api-key"], entry.body])).toEqual([["/bindings/b1/v1/messages?beta=true", "stand-in", "{\"messages\":[]}"]])
    expect(forwarded).toEqual([])
  })

  test("while the desktop offers the provider the call goes to the desktop, whose answer, a refusal included, is final", async () => {
    const hosted = await hostedBroker()
    const refusing = channel(["anthropic"], async () => Response.json({ error: { code: "binding_unavailable" } }, { status: 403 }))
    const front = await shim(refusing.channels)
    const baseUrl = front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in" })

    const answer = await send(baseUrl, "stand-in")

    expect([answer.status, await answer.json()]).toEqual([403, { error: { code: "binding_unavailable" } }])
    expect(refusing.forwarded.map((request) => [request.method, request.path])).toEqual([["POST", "/providers/anthropic/v1/messages?beta=true"]])
    expect(hosted.seen).toEqual([])
  })

  test("a call that found no channel goes hosted, and one whose channel broke after it was sent fails once and goes nowhere else", async () => {
    const hosted = await hostedBroker()
    let broken = false
    const flaky = channel(["anthropic"], async () => {
      if (broken) throw new Error("the desktop vanished mid-call")
      return undefined
    })
    const front = await shim(flaky.channels)
    const baseUrl = front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in" })

    expect((await send(baseUrl, "stand-in")).status).toBe(200)
    expect(hosted.seen).toHaveLength(1)
    broken = true
    const failed = await send(baseUrl, "stand-in")
    expect([failed.status, (await failed.json() as { error: { code: string } }).error.code]).toEqual([502, "owner_broker_unreachable"])
    expect(hosted.seen).toHaveLength(1)
  })

  test("a caller presenting no stand-in its row carries, an unknown route and a socket upgrade spend nothing", async () => {
    const hosted = await hostedBroker()
    const offered = channel(["anthropic"], async () => Response.json({ route: "desktop" }))
    const front = await shim(offered.channels)
    const baseUrl = front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in", expiresAt: Date.now() + 60_000 })
    front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "expired-stand-in", expiresAt: Date.now() - 1 })

    expect((await send(baseUrl, "another-stand-in")).status).toBe(401)
    expect((await send(baseUrl, "expired-stand-in")).status).toBe(401)
    expect((await send(`${new URL(baseUrl).origin}/routes/${"0".repeat(24)}`, "stand-in")).status).toBe(404)
    const upgrade = await new Promise<string>((resolve) => {
      const socket = connect(Number(new URL(baseUrl).port), "127.0.0.1", () => {
        socket.write(`GET ${new URL(baseUrl).pathname}/v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nx-api-key: stand-in\r\n\r\n`)
      })
      socket.once("data", (data) => {
        resolve(data.toString().split("\r\n")[0] ?? "")
        socket.destroy()
      })
    })
    expect(upgrade).toBe("HTTP/1.1 403 Forbidden")
    expect(offered.forwarded).toEqual([])
    expect(hosted.seen).toEqual([])
  })

  test("a row keeps its base URL across renewed stand-ins, and the stand-in it replaced is honoured until it expires", async () => {
    const hosted = await hostedBroker()
    const { channels } = channel([], async () => undefined)
    const front = await shim(channels)
    const first = front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in-1", expiresAt: Date.now() + 60_000 })
    const renewed = front.front({ providerId: "anthropic", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in-2", expiresAt: Date.now() + 120_000 })

    expect(renewed).toBe(first)
    expect((await send(first, "stand-in-1")).status).toBe(200)
    expect((await send(first, "stand-in-2")).status).toBe(200)
    expect(front.front({ providerId: "openai", baseUrl: `${hosted.url}/bindings/b1`, placeholder: "stand-in-3" })).not.toBe(first)
  })

  test("the rows a runtime resolves: the built ones spent through the shim, the owner's pushed ones where they say", async () => {
    const hosted = await hostedBroker()
    const { channels } = channel([], async () => undefined)
    const front = await shim(channels)
    installHostProviderConfigAuthority(front)
    closers.push(() => {
      setHostProviderConfig(null)
      installHostProviderConfigAuthority()
      resetHostEnrolledOwner()
    })
    await adoptConnectedHostOwner("owner", { applyRuntimeConfig: async () => {} })
    const built = { baseUrl: `${hosted.url}/bindings/b1`, placeholder: "built-stand-in", authMode: "api-key" as const, apiPath: "/v1", expiresAt: Date.now() + 60_000 }
    const pushed = { baseUrl: "https://gateway.example/anthropic", placeholder: "pushed-stand-in", authMode: "api-key" as const }
    setHostProviderConfig(JSON.stringify({ version: 1, source: "control-plane", credentials: { machineOwnerUserId: "owner", accounts: { owner: { anthropic: built, openai: built, gone: { unavailable: true, reason: "auth_failed" } } } } }))
    setHostProviderConfig(JSON.stringify({ version: 1, source: "owner", credentials: { machineOwnerUserId: "owner", accounts: { owner: { openai: pushed } } } }))

    const rows = (await projectRuntimeAuth({ scope: "local", workspaceId: "ws" })).accounts.owner
    const anthropic = rows?.anthropic as typeof built

    expect(anthropic).toEqual({ ...built, baseUrl: front.front({ providerId: "anthropic", baseUrl: built.baseUrl, placeholder: built.placeholder, expiresAt: built.expiresAt }) })
    expect(new URL(anthropic.baseUrl).origin).toBe(front.url)
    expect(rows?.openai).toEqual(pushed)
    expect(rows?.gone).toEqual({ unavailable: true, reason: "auth_failed" })
    expect((await send(anthropic.baseUrl, "built-stand-in")).status).toBe(200)
    expect(hosted.seen[0]?.url).toBe("/bindings/b1/v1/messages?beta=true")
  })
})
