import { decodeJwt } from "jose"
import { Hono } from "hono"
import type { WorkspaceRuntimeServerOptions } from "@claxedo/workspace-runtime"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { workspaceId } from "@claxedo/workspace-runtime/host"
import { SESSION_ROWS_PASS_PATH, type SessionRowsPassHeld } from "@claxedo/server-core/hosts/workspace-runtime/env"
import { createRuntimeSessionRows } from "@claxedo/server-core/session/publish/runtime-session-rows"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { controlPlaneOrigin } from "./tasks-grant"
import { controlPlaneOnly } from "./control-plane-only"
import { expiryOf, halfLifeRenewal, nodeRenewalTimers, type RenewalOutcome, type RenewalTimers } from "./half-life-renewal"

const log = Log.create({ service: "cloud-session-rows" })

type SessionReads = Parameters<NonNullable<WorkspaceRuntimeServerOptions["bindSessionReads"]>>[0]

export type CloudSessionRows = Required<Pick<WorkspaceRuntimeServerOptions, "onPresentationEvent" | "bindSessionReads" | "beforeStoreClose">> & {
  /** Where the control plane hands this runtime its pass, and asks which one it holds. */
  routes: WorkspaceRuntimeRouteContribution
  stop: () => void
}

function held(token: string | undefined): SessionRowsPassHeld {
  if (!token) return null
  try {
    const claims = decodeJwt(token)
    const epoch = Number(claims.lease_epoch)
    if (!Number.isSafeInteger(epoch) || typeof claims.iat !== "number" || typeof claims.exp !== "number") return null
    return { epoch, issuedAt: claims.iat * 1_000, expiresAt: claims.exp * 1_000 }
  } catch {
    return null
  }
}

/**
 * A cloud runtime's publisher of its sessions' list rows: the shared runtime
 * rows over this runtime's own store and presentation events. It publishes
 * nothing until the control plane, as its service actor over the relay, hands
 * it a session rows pass for its lease epoch; it renews that pass at
 * half-life, and a pass the control plane hands it later replaces it.
 */
export function cloudSessionRows(
  env: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; now?: () => number; timers?: RenewalTimers } = {},
): CloudSessionRows | undefined {
  const origin = controlPlaneOrigin(env)
  if (!origin) return undefined
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const url = new URL("/api/claxedo/host/session-rows", origin).toString()
  const workspace = workspaceId(env)
  const hostId = env.WORKSPACE_RUNTIME_HOST_ID?.trim() || workspace
  let reads: SessionReads | undefined
  let token: string | undefined

  const mounted = () => {
    if (!reads) throw new Error("the workspace runtime has not bound its session reads yet")
    return reads
  }
  const rows = createRuntimeSessionRows({
    workspaceId: workspace,
    url,
    store: () => mounted().store(),
    sessionStatus: () => mounted().sessionStatus(),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const { publisher } = rows

  const adopt = (next: string) => {
    const expiresAt = expiryOf(next)
    if (expiresAt === undefined) return false
    token = next
    publisher.credentialChanged({ hostId, token, workspaceIds: [workspace] })
    renewal.track(expiresAt)
    return true
  }
  const renew = async (): Promise<RenewalOutcome> => {
    const sent = token
    try {
      const response = await send(url, {
        method: "POST",
        headers: { authorization: `Bearer ${sent}`, "content-type": "application/json" },
        body: JSON.stringify({ hostId, rows: [], removed: [] }),
      })
      if (response.status === 401) {
        log.warn("session rows pass refused; waiting for the control plane to deliver one", { workspaceId: workspace })
        return { kind: "refused" }
      }
      const next = stringField(asRecord(asRecord(await response.json().catch(() => undefined))?.credential), "token")
      const expiresAt = next === undefined ? undefined : expiryOf(next)
      if (!response.ok || !next || expiresAt === undefined) throw new Error(`control plane answered ${response.status} without a pass`)
      if (token !== sent) return { kind: "refused" }
      token = next
      publisher.credentialChanged({ hostId, token, workspaceIds: [workspace] })
      return { kind: "renewed", expiresAt }
    } catch (error) {
      log.warn("session rows pass renewal failed", { workspaceId: workspace, error: String(error) })
      return { kind: "failed" }
    }
  }
  const renewal = halfLifeRenewal({
    renew,
    lapsed: () => log.warn("session rows pass lapsed; waiting for the control plane to deliver one", { workspaceId: workspace }),
    now,
    timers: options.timers ?? nodeRenewalTimers(),
  })

  return {
    onPresentationEvent: rows.onPresentationEvent,
    bindSessionReads: (bound) => {
      reads = bound
    },
    beforeStoreClose: () => publisher.flush(),
    routes: {
      id: "session-rows",
      mount: () => {
        const routes = new Hono()
        routes.use(SESSION_ROWS_PASS_PATH, controlPlaneOnly("Only the control plane hands this runtime its session rows pass"))
        routes.get(SESSION_ROWS_PASS_PATH, (c) => c.json({ held: held(token) }))
        routes.put(SESSION_ROWS_PASS_PATH, async (c) => {
          const next = stringField(asRecord(await c.req.json().catch(() => undefined)), "token")
          if (!next || !adopt(next)) return c.json({ error: { code: "invalid_session_rows_pass", message: "A session rows pass is required" } }, 400)
          return c.body(null, 204)
        })
        return { path: "/", routes, dispose: () => {} }
      },
    },
    stop: () => {
      renewal.stop()
      rows.stop()
    },
  }
}
