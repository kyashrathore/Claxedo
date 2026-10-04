import { describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { nativeProviderDeliveriesFromRepository, nativeProviderSecrets, type SandboxSecretBrokering } from "@claxedo/server-core/credentials/native-delivery-plan"
import { createCloudflareSandboxDriver } from "@claxedo/sandbox-manager/drivers/cloudflare"
import { createLocalBrokeringSandboxDriver } from "@claxedo/sandbox-manager/drivers/local-brokering"
import { vercelBrokeredNetworkPolicy } from "@claxedo/sandbox-manager/drivers/vercel"
import { forwardCredential, parseRegistrations } from "../../scripts/sandbox/cloudflare-worker/src/outbound-credentials"

const KEY = "cursor-private-key"
const ACCESS = "cursor-access-token"
const CURSOR = "https://api2.cursor.sh"
const EXCHANGE = "/auth/exchange_user_api_key"
const RPC = "/agent.v1.AgentService/Run"

async function cursorDeliveries(secretBrokering: SandboxSecretBrokering) {
  const now = Date.now()
  return await nativeProviderDeliveriesFromRepository({
    owner: "owner", machineOwnerUserId: "owner", selections: {}, secretBrokering,
    selected: [{ credential: {
      id: "cred_owner_cursor", owner: "owner", provider_id: "cursor-sdk", kind: "api_key", source: "managed", status: "available",
      created_at: now, updated_at: now, activated_at: now, revision: 1, incarnation: "cred_owner_cursor",
    } }],
    readSecret: async () => KEY,
  })
}

async function cursorSecret() {
  const [secret] = nativeProviderSecrets(await cursorDeliveries("native"))
  if (!secret) throw new Error("a native-brokering driver was delivered no Cursor secret")
  return { ...secret, methods: [...secret.methods], pathPrefixes: [...secret.pathPrefixes] }
}

type Seen = { method: string; path: string; authorization: string | null }

function scriptedCursor(seen: Seen[]) {
  return async (request: Request) => {
    const url = new URL(request.url)
    seen.push({ method: request.method, path: url.pathname, authorization: request.headers.get("authorization") })
    return url.pathname === EXCHANGE ? Response.json({ accessToken: ACCESS }) : new Response("ok")
  }
}

describe("a Cursor account in a native-brokering sandbox", () => {
  test("a driver that cannot broker still gets nothing", async () => {
    const deliveries = await cursorDeliveries("none")
    expect(nativeProviderSecrets(deliveries)).toEqual([])
    expect(deliveries[0]?.projection).toEqual({ unavailable: true, reason: "secret_brokering_unsupported" })
  })

  test("Vercel's firewall writes the key only on Cursor's exchange request", async () => {
    const secret = await cursorSecret()
    expect(vercelBrokeredNetworkPolicy([secret], "deny-all")).toEqual({ allow: {
      "api2.cursor.sh": [{
        match: { path: { startsWith: EXCHANGE }, method: ["POST"],
          headers: [{ key: { exact: "authorization" }, value: { exact: `Bearer claxedo-broker:${secret.name}` } }] },
        transform: [{ headers: { Authorization: `Bearer ${KEY}` } }],
      }],
    } })
  })

  test("the Cloudflare Worker swaps the key into the exchange and leaves the returned token alone", async () => {
    const secret = await cursorSecret()
    let egress: unknown
    const driver = createCloudflareSandboxDriver({
      workerUrl: "https://sbx.example.com/", apiToken: "worker-secret", nativeHarness: "opencode",
      controlEnv: { relayJwksUrl: "https://relay.test/.well-known/jwks.json", managementJwksUrl: "https://control.test/.well-known/jwks.json" },
      fetch: (async (url: string, init: RequestInit) => {
        const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined
        if (url.endsWith("/ensure-runtime") && typeof body === "object" && body !== null && "egress" in body) egress = body.egress
        return Response.json({ ready: true, url: "https://sbx.example.com/proxy" })
      }) as typeof fetch,
    })
    await driver.ensureHost({ workspaceId: "ws_cursor", homeRegion: "us-east", epoch: 1, labels: {}, secrets: [secret] })
    const registrations = parseRegistrations(egress)
    const seen: Seen[] = []
    const send = (pathname: string, authorization: string) => forwardCredential(
      new Request(`${CURSOR}${pathname}`, { method: "POST", headers: { authorization } }),
      { registrations: async () => registrations, fetch: scriptedCursor(seen) },
    )

    const exchanged = await send(EXCHANGE, `Bearer claxedo-broker:${secret.name}`)
    expect(await exchanged.json()).toEqual({ accessToken: ACCESS })
    expect((await send(RPC, `Bearer ${ACCESS}`)).status).toBe(200)
    expect((await send(RPC, `Bearer claxedo-broker:${secret.name}`)).status).toBe(403)
    expect(seen).toEqual([
      { method: "POST", path: EXCHANGE, authorization: `Bearer ${KEY}` },
      { method: "POST", path: RPC, authorization: `Bearer ${ACCESS}` },
    ])
  })

  test.skipIf(process.platform !== "darwin")("end to end through the local brokering driver, the sandbox exchanges the key it never holds and spends the returned token", async () => {
    const secret = await cursorSecret()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exchange-"))
    const seen: Seen[] = []
    const upstream = http.createServer((request, response) => {
      seen.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization ?? null })
      response.writeHead(200, { "content-type": "application/json" })
      response.end(request.url === EXCHANGE ? JSON.stringify({ accessToken: ACCESS }) : "{}")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (!address || typeof address === "string") throw new Error("scripted Cursor backend has no port")
    const sandbox = `require('node:http').createServer(async (req, res) => {
      if (req.url === '/global/health') return res.end('ok')
      if (req.url === '/env') return res.end(JSON.stringify(process.env))
      const post = (path, token) => fetch('${CURSOR}' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: '{}', signal: AbortSignal.timeout(3000) })
      try {
        const exchange = await post('${EXCHANGE}', process.env[process.env.CURSOR_KEY_ENV])
        const { accessToken } = await exchange.json()
        const rpc = await post('${RPC}', accessToken)
        const stray = await post('${RPC}', process.env[process.env.CURSOR_KEY_ENV])
        res.end(JSON.stringify({ exchange: exchange.status, accessToken, rpc: rpc.status, stray: stray.status }))
      } catch (error) { res.end(String(error) + ' ' + String(error.cause)) }
    }).listen(process.env.WORKSPACE_RUNTIME_PORT, '127.0.0.1')`
    const driver = createLocalBrokeringSandboxDriver({
      root, executable: process.execPath, args: ["-e", sandbox], allowedOrigins: [], directOrigins: [],
      upstreams: { [CURSOR]: `http://127.0.0.1:${address.port}` }, inheritedEnv: { CURSOR_KEY_ENV: secret.name },
    })
    try {
      const target = await driver.ensureHost({ workspaceId: "cursor", homeRegion: "local", epoch: 1, labels: {}, secrets: [secret] })
      if ("provisioning" in target) throw new Error("local test driver did not return a ready target")
      const env = await (await fetch(`${target.url}/env`)).text()
      expect(env).not.toContain(KEY)
      expect(JSON.parse(env)[secret.name]).toBe(`claxedo-broker:${secret.name}`)
      expect(await (await fetch(`${target.url}/turn`)).json()).toEqual({ exchange: 200, accessToken: ACCESS, rpc: 200, stray: 403 })
      expect(seen).toEqual([
        { method: "POST", path: EXCHANGE, authorization: `Bearer ${KEY}` },
        { method: "POST", path: RPC, authorization: `Bearer ${ACCESS}` },
      ])
      await driver.stop?.(target)
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
