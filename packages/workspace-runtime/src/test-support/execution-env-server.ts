import { setTimeout as sleep } from "node:timers/promises"
import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { Hono } from "hono"
import { generateKeyPair } from "jose"
import { volatileLaunchOwnership } from "@claxedo/process-ownership/launch"
import type { PluginProjection } from "@claxedo/harness/contract"
import { createRelayHostAuthMiddleware } from "@claxedo/session-core/relay-host"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { ExecutionEnvRoutes } from "../routes/execution-env"
import { WorkspaceRuntimeRoutes } from "../routes/manifest"
import { waitForWorkspaceRuntimeServerPort } from "../server"
import { createSpawnService } from "../spawn-service"

export type ExecutionEnvClaims = {
  sessionId?: string
  role?: "viewer" | "editor" | "admin" | "owner"
  backing?: "cloud-vm" | "local-worktree"
  /** A share holder's token: the session claim without the turn-execution purpose. */
  share?: true
}

const EMPTY_PROJECTION: PluginProjection = { generation: "empty", mcpServers: [], pluginRoots: [], notApplied: [] }

/** The execution-env routes behind the real relay-host verifier and owned spawn. */
export async function executionEnvApp(input: { directory: string; env?: NodeJS.ProcessEnv; projection?: PluginProjection; mcpHeartbeatMs?: number }) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const app = new Hono()
  const sockets = createNodeWebSocket({ app })
  app.use("*", createRelayHostAuthMiddleware({ key: key.publicKey, workspaceId: "ws_1", hostId: "host_1" }))
  const executionEnv = ExecutionEnvRoutes({
    directory: input.directory,
    env: input.env ?? process.env,
    services: { spawn: createSpawnService(volatileLaunchOwnership()), clock: { now: Date.now, setTimeout, clearTimeout }, log: console },
    piProjection: () => input.projection ?? EMPTY_PROJECTION,
    upgradeWebSocket: sockets.upgradeWebSocket,
    ...(input.mcpHeartbeatMs ? { mcpHeartbeatMs: input.mcpHeartbeatMs } : {}),
  })
  app.route(WorkspaceRuntimeRoutes.executionEnv, executionEnv.routes)
  const headers = async (claims: ExecutionEnvClaims = {}) => ({
    authorization: `Bearer ${await mintRelayHostToken({
      principalKind: "user", actorId: "actor_1", actorKind: "human", orgId: "org_1", workspaceId: "ws_1", hostId: "host_1",
      role: claims.role ?? "editor", backing: claims.backing ?? "cloud-vm", parentJti: "rat_1",
      ...(claims.sessionId === undefined ? {} : { sessionId: claims.sessionId }),
      ...(claims.share ? {} : { purpose: "turn-execution" as const }),
    }, key.privateKey, "EdDSA")}`,
    "x-workspace-id": "ws_1",
    "x-forwarded-by": "workspace-relay",
  })
  return { app, sockets, headers, dispose: executionEnv.dispose }
}

/** {@link executionEnvApp} served over HTTP and WebSocket, for what only a real connection shows: disconnects and upgrades. */
export async function serveExecutionEnv(input: Parameters<typeof executionEnvApp>[0]) {
  const { app, sockets, headers, dispose } = await executionEnvApp(input)
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" })
  sockets.injectWebSocket(server)
  const port = await waitForWorkspaceRuntimeServerPort(server, 0)
  return {
    origin: `http://127.0.0.1:${port}`,
    headers,
    close: (() => {
      let closing: Promise<void> | undefined
      return () => closing ??= dispose().then(() => new Promise<void>((resolve) => server.close(() => resolve())))
    })(),
  }
}

export function pidRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether `pid` exits within `ms`; process exit is observed by polling because nothing here is its parent. */
export async function waitForPidExit(pid: number, ms: number) {
  const deadline = Date.now() + ms
  while (pidRunning(pid) && Date.now() < deadline) await sleep(25)
  return !pidRunning(pid)
}
