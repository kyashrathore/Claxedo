import { initTRPC, TRPCError } from "@trpc/server"
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { z } from "zod"
import * as authority from "../cloud/authority"
import type { ControlPlaneServices } from "./services"
import { resolveWorkspace, updateWorkspace } from "../workspace-store"
import { resolveRunnerHostForRequest } from "../runner-resolution"

type Context = {
  services: ControlPlaneServices
}

const t = initTRPC.context<Context>().create()

const workspaceScoped = z.object({
  workspaceId: z.string().min(1),
})

const sessionSyncInput = workspaceScoped.extend({
  session: z.unknown(),
})

const sessionSyncManyInput = workspaceScoped.extend({
  sessions: z.array(z.unknown()),
})

const sessionDeleteInput = workspaceScoped.extend({
  sessionId: z.string().min(1),
})

const gatewayInput = z.object({
  sessionId: z.string().min(1),
})

const runtimeSnapshotInput = workspaceScoped.extend({
  ok: z.boolean(),
  status: z.string(),
  directory: z.string(),
  profile: z.string(),
  agentType: z.string(),
  model: z.string().nullable(),
  ptyCount: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  activeProcessCount: z.number().int().nonnegative(),
  runtimeUrl: z.string().nullable().optional(),
  leaseId: z.string().nullable().optional(),
  sandboxId: z.string().nullable().optional(),
  epoch: z.number().int().nullable().optional(),
})

async function workspaceStrict(workspaceId: string) {
  const hit = await resolveWorkspace({ workspaceId })
  if (hit) return hit
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `workspace ${workspaceId} not found`,
  })
}

function patchLease(input: z.infer<typeof runtimeSnapshotInput>) {
  const now = Date.now()
  const active = input.activeProcessCount > 0 || input.ptyCount > 0
  const lease = authority.getLease(input.workspaceId)
  if (!lease) return
  authority.updateLease(input.workspaceId, {
    ...(input.ok && lease.status !== "ready" ? { status: "ready" } : {}),
    ...(input.status === "unhealthy" ? { status: "unhealthy" } : {}),
    ...(input.runtimeUrl ? { runtime_url: input.runtimeUrl } : {}),
    last_heartbeat_at: now,
    ...(active ? { last_activity_at: now } : {}),
  })
}

export async function resolveSessionGateway(services: ControlPlaneServices, sessionId: string) {
  const meta = await services.projectionStore.session_meta(sessionId)
  if (!meta) {
    return {
      gatewayUrl: null,
      workspaceId: null,
      directory: null,
      runnerHost: null,
    }
  }
  const ws = meta.workspaceID
    ? await resolveWorkspace({ workspaceId: meta.workspaceID })
    : meta.directory
      ? await resolveWorkspace({ directory: meta.directory })
      : undefined
  if (!ws || ws.kind !== "cloud") {
    return {
      gatewayUrl: null,
      workspaceId: meta.workspaceID ?? null,
      directory: meta.directory,
      runnerHost: null,
    }
  }
  const runnerHost = await resolveRunnerHostForRequest({
    workspaceId: ws.id,
    directory: meta.directory,
    sessionId,
  })
  const gatewayUrl = runnerHost === "workspace"
    ? authority.getLease(ws.id)?.runtime_url ?? ws.sandbox_url ?? null
    : null
  return {
    gatewayUrl: typeof gatewayUrl === "string" ? gatewayUrl.replace(/\/+$/, "") : null,
    workspaceId: ws.id,
    directory: meta.directory,
    runnerHost,
  }
}

export function createControlPlaneRouter(services: ControlPlaneServices) {
  return t.router({
    session: t.router({
      sync: t.procedure.input(sessionSyncInput).mutation(async ({ input }) => {
        const ws = await workspaceStrict(input.workspaceId)
        await services.projectionStore.sync_session_meta(ws, input.session)
        return { ok: true }
      }),
      syncMany: t.procedure.input(sessionSyncManyInput).mutation(async ({ input }) => {
        const ws = await workspaceStrict(input.workspaceId)
        await services.projectionStore.sync_session_metas(ws, input.sessions)
        return { ok: true }
      }),
      delete: t.procedure.input(sessionDeleteInput).mutation(async ({ input }) => {
        await workspaceStrict(input.workspaceId)
        await services.projectionStore.delete_session_meta(input.sessionId)
        return { ok: true }
      }),
      gateway: t.procedure.input(gatewayInput).query(async ({ input }) =>
        resolveSessionGateway(services, input.sessionId)),
    }),
    runtime: t.router({
      register: t.procedure.input(runtimeSnapshotInput).mutation(async ({ input }) => {
        const ws = await workspaceStrict(input.workspaceId)
        await updateWorkspace(input.workspaceId, {
          status: input.status || (input.ok ? "ready" : ws.status),
        })
        patchLease(input)
        return { ok: true }
      }),
      heartbeat: t.procedure.input(runtimeSnapshotInput).mutation(async ({ input }) => {
        await workspaceStrict(input.workspaceId)
        patchLease(input)
        return { ok: true }
      }),
    }),
  })
}

export type ControlPlaneRouter = ReturnType<typeof createControlPlaneRouter>

export function controlPlaneTrpcHandler(services: ControlPlaneServices) {
  const router = createControlPlaneRouter(services)
  return (req: Request) =>
    fetchRequestHandler({
      endpoint: "/api/control/trpc",
      req,
      router,
      createContext: () => ({ services }),
    })
}
