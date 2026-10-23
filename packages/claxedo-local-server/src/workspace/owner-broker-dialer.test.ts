import { afterEach, beforeAll, describe, expect, test } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { decodeJwt, exportJWK, exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { createDirectTlsKey, directTlsIdentity, type DirectTlsIdentity } from "@claxedo/host-serving/direct-certificate"
import { startDirectListener, type DirectListener } from "@claxedo/host-serving/direct-listener"
import { createOwnerBrokerChannels, type OwnerBrokerChannels } from "@claxedo/host-serving/owner-broker-channel"
import { startOwnerBrokerShim, type OwnerBrokerShim } from "@claxedo/host-serving/owner-broker-shim"
import { mintOwnerBrokerPass } from "@claxedo/server-core/credentials/owner-broker-pass"
import { createOwnerBrokerDialer, type OwnerBrokerDialer } from "./owner-broker-dialer"

const HOST_ID = "host_lan-box"
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
const OWNER = "user_owner"
const KID = "control-plane-key"
const HOSTED_STAND_IN = "hosted-stand-in"
const DESKTOP_STAND_IN = "desktop-stand-in"

type Seen = { url: string; headers: IncomingHttpHeaders; body: string }

const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

function listen(server: Server) {
  closers.push(() => new Promise<void>((done) => {
    server.close(() => done())
    server.closeAllConnections()
  }))
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function recorder(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => { body += chunk.toString() })
    request.on("end", async () => {
      const entry = { url: request.url ?? "/", headers: request.headers, body }
      seen.push(entry)
      const reply = await answer(entry)
      response.writeHead(reply.status, Object.fromEntries(reply.headers))
      response.end(Buffer.from(await reply.arrayBuffer()))
    })
  })
  return { seen, server }
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe("a connected machine spends its owner's accounts through the desktop that reaches it", () => {
  let signing: Awaited<ReturnType<typeof generateKeyPair>>
  let env: Record<string, string>
  let keysUrl: string
  let authorityUrl: string
  const revoked = new Set<string>()

  beforeAll(async () => {
    signing = await generateKeyPair("EdDSA", { extractable: true })
    env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(signing.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(signing.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_KID: KID,
    }
    const jwks = { keys: [{ ...(await exportJWK(signing.publicKey)), kid: KID, alg: "EdDSA", use: "sig" }] }
    keysUrl = `${await listen(createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(jwks))
    }))}/.well-known/jwks.json`
    authorityUrl = `${await listen(createServer((request, response) => {
      request.resume()
      request.on("end", () => {
        const jti = String(decodeJwt(request.headers.authorization?.slice("Bearer ".length) ?? "").jti)
        response.setHeader("content-type", "application/json")
        response.statusCode = revoked.has(jti) ? 401 : 200
        response.end(JSON.stringify(revoked.has(jti)
          ? { error: { code: "runtime_access_token_revoked", message: "revoked" } }
          : { lease: "workspace-lease", expiresAt: Date.now() + 60_000 }))
      })
    }))}/session-authorize`
    closers.splice(0)
  })

  function ownerToken(jti: string = crypto.randomUUID()) {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({
      principal_kind: "user", actor_id: "actor_owner", user_id: OWNER, actor_kind: "human", org_id: "org_1",
      workspace_id: WORKSPACE_ID, host_id: HOST_ID, role: "owner", scope: "workspace",
    }).setProtectedHeader({ alg: "EdDSA", kid: KID }).setIssuer("claxedo-control-plane").setAudience("workspace-relay")
      .setIssuedAt(now).setExpirationTime(now + 30 * 60).setJti(jti).sign(signing.privateKey)
  }

  async function world(options: { desktopAnswer?: (request: Request) => Response; spki?: string; passMintedAt?: number } = {}) {
    const identity: DirectTlsIdentity = await directTlsIdentity(await createDirectTlsKey())
    const hosted = recorder(() => Response.json({ route: "hosted" }))
    const hostedUrl = await listen(hosted.server)
    const channels: OwnerBrokerChannels = createOwnerBrokerChannels({ hostId: HOST_ID, runtimeAccessJwksUrl: keysUrl, sessionAuthorityUrl: () => authorityUrl })
    closers.push(() => channels.close())
    const shim: OwnerBrokerShim = await startOwnerBrokerShim({ channels })
    closers.push(() => shim.close())
    const direct: DirectListener = startDirectListener({
      identity,
      runtime: { url: "http://127.0.0.1:9", fetch: async () => new Response(null, { status: 404 }), upgrade: (_request, socket) => socket.destroy() },
      addresses: () => ["127.0.0.1"],
      ownerBroker: channels,
    })
    closers.push(() => direct.close())
    const routes = await direct.routes()
    if (!routes) throw new Error("nothing listens")
    const mintedAt = options.passMintedAt
    const pass = await mintOwnerBrokerPass({ ownerUserId: OWNER, orgId: "org_1", enrollmentId: "enr_1", hostId: HOST_ID, spkiSha256: options.spki ?? identity.spkiSha256 }, env, mintedAt === undefined ? {} : { now: () => mintedAt })
    channels.setPass(pass.token)
    const desktopCalls: Request[] = []
    const dialer: OwnerBrokerDialer = createOwnerBrokerDialer({
      jwksUrl: keysUrl,
      project: async () => ({ anthropic: { baseUrl: "http://127.0.0.1:1/bindings/desktop-binding", placeholder: DESKTOP_STAND_IN } }),
      broker: async (request) => {
        desktopCalls.push(request)
        return options.desktopAnswer?.(request) ?? Response.json({ route: "desktop", path: new URL(request.url).pathname, body: await request.text() })
      },
    })
    closers.push(() => dialer.forget())
    const baseUrl = shim.front({ providerId: "anthropic", baseUrl: `${hostedUrl}/bindings/hosted-binding`, placeholder: HOSTED_STAND_IN, expiresAt: Date.now() + 60 * 60_000 })
    const target = { address: "127.0.0.1", port: routes.port, spkiSha256: identity.spkiSha256 }
    const call = async (standIn = HOSTED_STAND_IN) => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": standIn, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "scripted", messages: [] }),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    return { channels, dialer, hosted, desktopCalls, target, call }
  }

  test("a call goes to the desktop's broker with the desktop's stand-in while the desktop serves its provider, and nothing reaches the hosted broker", async () => {
    const { channels, dialer, hosted, desktopCalls, target, call } = await world()
    dialer.offer({ target, token: await ownerToken() })
    await until(() => (channels.offers("anthropic") ? true : undefined), "the desktop's offer")

    const answer = await call()

    expect(answer).toEqual({ status: 200, body: { route: "desktop", path: "/bindings/desktop-binding/v1/messages", body: JSON.stringify({ model: "scripted", messages: [] }) } })
    expect(desktopCalls[0]?.headers.get("authorization")).toBe(`Bearer ${DESKTOP_STAND_IN}`)
    expect(desktopCalls[0]?.headers.get("x-api-key")).toBeNull()
    expect(desktopCalls[0]?.headers.get("anthropic-version")).toBe("2023-06-01")
    expect(hosted.seen).toEqual([])
  })

  test("a refusal from the desktop's broker is the answer, and the call is not sent again to the hosted broker", async () => {
    const { channels, dialer, hosted, target, call } = await world({
      desktopAnswer: () => Response.json({ error: { code: "binding_unavailable" } }, { status: 403 }),
    })
    dialer.offer({ target, token: await ownerToken() })
    await until(() => (channels.offers("anthropic") ? true : undefined), "the desktop's offer")

    expect(await call()).toEqual({ status: 403, body: { error: { code: "binding_unavailable" } } })
    expect(hosted.seen).toEqual([])
  })

  test("without a desktop channel, after the desktop goes, and while the owner pauses the machine, calls go to the hosted binding; they return to the desktop when it does", async () => {
    const { channels, dialer, hosted, target, call } = await world()
    expect((await call()).body.route).toBe("hosted")
    expect(hosted.seen[0]?.url).toBe("/bindings/hosted-binding/v1/messages")
    expect(hosted.seen[0]?.headers["x-api-key"]).toBe(HOSTED_STAND_IN)

    dialer.offer({ target, token: await ownerToken() })
    await until(() => (channels.offers("anthropic") ? true : undefined), "the desktop's offer")
    expect((await call()).body.route).toBe("desktop")

    channels.withhold(true)
    expect((await call()).body.route).toBe("hosted")
    channels.withhold(false)
    await until(() => (channels.offers("anthropic") ? true : undefined), "the desktop to dial again after the resume")
    expect((await call()).body.route).toBe("desktop")

    dialer.forget()
    await until(() => (channels.offers("anthropic") ? undefined : true), "the channel to close")
    expect((await call()).body.route).toBe("hosted")
  })

  test("a desktop holding a revoked token opens no channel, and a pass naming another key is offered nothing", async () => {
    const revokedWorld = await world()
    const jti = crypto.randomUUID()
    revoked.add(jti)
    revokedWorld.dialer.offer({ target: revokedWorld.target, token: await ownerToken(jti) })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(revokedWorld.channels.offers("anthropic")).toBe(false)
    expect((await revokedWorld.call()).body.route).toBe("hosted")
    expect(revokedWorld.desktopCalls).toEqual([])

    const foreign = await world({ spki: "A".repeat(43) })
    foreign.dialer.offer({ target: foreign.target, token: await ownerToken() })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(foreign.channels.offers("anthropic")).toBe(false)
    expect((await foreign.call()).body.route).toBe("hosted")
    expect(foreign.desktopCalls).toEqual([])
  })

  test("a machine whose last pass has lapsed, as a revoked or paused one's does, is offered nothing even over an open channel", async () => {
    const lapsed = await world({ passMintedAt: Date.now() - 2 * 60_000 })
    lapsed.dialer.offer({ target: lapsed.target, token: await ownerToken() })
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(lapsed.channels.offers("anthropic")).toBe(false)
    expect((await lapsed.call()).body.route).toBe("hosted")
    const sentAnyway = await lapsed.channels.forward({ method: "POST", path: "/providers/anthropic/v1/messages", headers: new Headers(), body: null, signal: new AbortController().signal })
    expect([sentAnyway?.status, await sentAnyway?.json()]).toEqual([403, { error: { code: "owner_broker_pass_refused", message: "The machine's pass from the control plane is missing, lapsed or not its own" } }])
    expect(lapsed.desktopCalls).toEqual([])
  })

  test("a caller without its row's stand-in spends nothing anywhere", async () => {
    const { channels, dialer, hosted, desktopCalls, target, call } = await world()
    dialer.offer({ target, token: await ownerToken() })
    await until(() => (channels.offers("anthropic") ? true : undefined), "the desktop's offer")

    expect((await call("another-stand-in")).status).toBe(401)
    expect(desktopCalls).toEqual([])
    expect(hosted.seen).toEqual([])
  })
})
