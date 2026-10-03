import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { Hono } from "hono"
import type { AddressInfo } from "node:net"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import type { PluginProjection } from "@claxedo/harness/contract"
import { createRelayHostAuthMiddleware } from "@claxedo/session-core/relay-host"
import { mintRelayHostToken, relayHostInputFromRuntimeClaims, verifyRuntimeAccessToken } from "@claxedo/workspace-relay"
import { createSpawnService, ExecutionEnvRoutes } from "@claxedo/workspace-runtime/execution-env"
import { MACHINE_HOST, WORKSPACE_ID } from "./control-plane"

const PREFIX = `/workspaces/${WORKSPACE_ID}`

/**
 * A cloud workspace machine behind the relay: the real `execution-env` routes
 * over the real relay host verifier and owned spawn, fronted by the relay's
 * own exchange of a Runtime Access Token for a Relay Host Token. Plain HTTP,
 * event streams and WebSocket upgrades all pass the same exchange.
 */
export async function startWorkspaceMachine(input: {
  directory: string
  projection: () => PluginProjection
  runtimeAccessKey: CryptoKey
  relayHostKeys: { publicKey: CryptoKey; privateKey: CryptoKey }
}) {
  const relay = new Hono()
  const sockets = createNodeWebSocket({ app: relay })
  const machine = new Hono()
  machine.use("*", createRelayHostAuthMiddleware({ key: input.relayHostKeys.publicKey, workspaceId: WORKSPACE_ID, hostId: MACHINE_HOST }))
  const routes = ExecutionEnvRoutes({
    directory: input.directory, env: { PATH: process.env.PATH, HOME: input.directory },
    services: { spawn: createSpawnService(volatileLaunchOwnership()), clock: { now: Date.now, setTimeout, clearTimeout }, log: console },
    piProjection: input.projection, upgradeWebSocket: sockets.upgradeWebSocket,
  })
  machine.route("/api/wr/execution-env", routes.routes)
  relay.all(`${PREFIX}/*`, async (c) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? ""
    const claims = await verifyRuntimeAccessToken(token, input.runtimeAccessKey, { workspaceId: WORKSPACE_ID, hostId: MACHINE_HOST }).catch(() => undefined)
    if (!claims) return c.json({ error: { code: "runtime_access_token_invalid" } }, 401)
    const relayHostToken = await mintRelayHostToken({
      ...relayHostInputFromRuntimeClaims(claims), workspaceId: WORKSPACE_ID, hostId: MACHINE_HOST, backing: "cloud-vm",
    }, input.relayHostKeys.privateKey, "EdDSA")
    const headers = new Headers(c.req.raw.headers)
    headers.set("authorization", `Bearer ${relayHostToken}`)
    headers.set("x-workspace-id", WORKSPACE_ID)
    headers.set("x-forwarded-by", "workspace-relay")
    const url = new URL(c.req.url)
    url.pathname = url.pathname.slice(PREFIX.length)
    const body = c.req.method === "GET" ? undefined : await c.req.arrayBuffer()
    return machine.fetch(new Request(url, { method: c.req.method, headers, body, signal: c.req.raw.signal }), c.env)
  })
  const server = serve({ fetch: relay.fetch, port: 0, hostname: "127.0.0.1" })
  sockets.injectWebSocket(server)
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  return {
    relayUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      await routes.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
