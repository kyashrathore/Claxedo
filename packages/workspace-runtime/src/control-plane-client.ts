import { createTRPCProxyClient, httpBatchLink } from "@trpc/client"
import type { ControlPlaneRouter } from "../../claxedo-server/src/control-plane/trpc"
import type { WorkspaceHost } from "./workspace"
import * as ProcessManager from "./process/index"
import { Pty } from "./pty/index"
import { Log } from "./log"
import { workspaceDir, workspaceId } from "./target"

const log = Log.create({ service: "control-plane-client" })
const HEARTBEAT_MS = 15_000

type Env = NodeJS.ProcessEnv

type RuntimeSnapshot = {
  workspaceId: string
  ok: boolean
  status: string
  directory: string
  profile: string
  agentType: string
  model: string | null
  ptyCount: number
  processCount: number
  activeProcessCount: number
  runtimeUrl?: string | null
  leaseId?: string | null
  sandboxId?: string | null
  epoch?: number | null
}

function baseUrl(env: Env) {
  const raw = env.CLAXEDO_CONTROL_PLANE_URL?.trim()
  if (!raw) return
  return raw.endsWith("/") ? raw.slice(0, -1) : raw
}

function runtimeIdentity(env: Env) {
  const epoch = env.CLAXEDO_WR_EPOCH
  return {
    runtimeUrl: env.CLAXEDO_WR_RUNTIME_URL ?? null,
    leaseId: env.CLAXEDO_WR_LEASE_ID ?? null,
    sandboxId: env.CLAXEDO_WR_SANDBOX_ID ?? null,
    epoch: epoch && Number.isFinite(Number(epoch)) ? Number(epoch) : null,
  }
}

function createClient(env: Env) {
  const base = baseUrl(env)
  if (!base) return
  return createTRPCProxyClient<ControlPlaneRouter>({
    links: [
      httpBatchLink({
        url: `${base}/api/control/trpc`,
        headers() {
          return {
            "x-workspace-id": workspaceId(env),
          }
        },
      }),
    ],
  })
}

function snapshot(host: WorkspaceHost, env: Env): RuntimeSnapshot {
  const detail = host.detail()
  const rows = ProcessManager.list(workspaceDir(env))
  return {
    workspaceId: workspaceId(env),
    ok: detail.state === "ready",
    status: detail.state,
    directory: workspaceDir(env),
    profile: host.capabilities().profile,
    agentType: detail.runner.type,
    model: detail.runner.model ?? null,
    ptyCount: Pty.list().length,
    processCount: rows.length,
    activeProcessCount: rows.filter((item) => item.status !== "idle" && item.status !== "stopped").length,
    ...runtimeIdentity(env),
  }
}

async function wrap(label: string, run: () => Promise<void>) {
  try {
    await run()
  } catch (error) {
    log.warn(`control plane ${label} failed`, {
      workspaceId: workspaceId(process.env),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function createControlPlaneClient(env: Env = process.env) {
  const client = createClient(env)
  if (!client) return
  const currentWorkspaceId = workspaceId(env)
  return {
    session: {
      sync(session: unknown) {
        return wrap("session sync", () =>
          client.session.sync.mutate({
            workspaceId: currentWorkspaceId,
            session,
          }).then(() => undefined))
      },
      syncMany(sessions: unknown[]) {
        return wrap("session list sync", () =>
          client.session.syncMany.mutate({
            workspaceId: currentWorkspaceId,
            sessions,
          }).then(() => undefined))
      },
      delete(sessionId: string) {
        return wrap("session delete sync", () =>
          client.session.delete.mutate({
            workspaceId: currentWorkspaceId,
            sessionId,
          }).then(() => undefined))
      },
    },
    runtime: {
      register(host: WorkspaceHost) {
        return wrap("runtime register", () =>
          client.runtime.register.mutate(snapshot(host, env)).then(() => undefined))
      },
      heartbeat(host: WorkspaceHost) {
        return wrap("runtime heartbeat", () =>
          client.runtime.heartbeat.mutate(snapshot(host, env)).then(() => undefined))
      },
    },
  }
}

export function startControlPlaneRuntimeSync(host: WorkspaceHost, env: Env = process.env) {
  const controlPlane = createControlPlaneClient(env)
  if (!controlPlane) return
  void controlPlane.runtime.register(host)
  const timer = setInterval(() => {
    void controlPlane.runtime.heartbeat(host)
  }, HEARTBEAT_MS)
  return () => {
    clearInterval(timer)
  }
}
