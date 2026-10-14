import { IDLE_CHECK_FAILURE_LIMIT, IDLE_CHECK_MS, WORKSPACE_IDLE_MS, workspaceIdleStopDue } from "../../../../src/sandbox/workspace-idle"
import { asWorkerRecord } from "./worker-json"

export { IDLE_CHECK_FAILURE_LIMIT }
export const IDLE_CHECK = "checkWorkspaceIdle"
export const IDLE_CHECK_SECONDS = IDLE_CHECK_MS / 1000

export type WorkspaceIdle = { workspaceId: string; epoch: number; port: number; idleMs: number; healthToken: string; failures?: number }

export type IdleEnv = { IDLE_STOP_TOKEN?: string; CONTROL_PLANE_URL?: string; WORKSPACE_IDLE_MS?: string }

/** The idle lifecycle a runtime's labels and this Worker's configuration describe, or `undefined` when they describe none. */
export function workspaceIdlePlacement(labels: Record<string, string>, port: number, env: IdleEnv): Omit<WorkspaceIdle, "healthToken"> | undefined {
  const epoch = Number(labels.epoch)
  const idleMs = Number(env.WORKSPACE_IDLE_MS ?? WORKSPACE_IDLE_MS)
  if (!env.CONTROL_PLANE_URL || !env.IDLE_STOP_TOKEN || !labels.workspaceId || !Number.isSafeInteger(epoch) || epoch < 1) return undefined
  if (!Number.isSafeInteger(idleMs) || idleMs < IDLE_CHECK_MS) return undefined
  return { workspaceId: labels.workspaceId, epoch, port, idleMs }
}

/**
 * Reads the runtime's own idle answer and, once the shared policy says a stop
 * is due, asks the control plane to settle this lease generation: it captures
 * an idle runtime and stops the lease, answers a lease it already stopped, and
 * thaws a runtime a failed capture left frozen. The answer names the
 * checkpoint the stopped lease references, or `undefined` when nothing is due.
 * The request carries the idle-stop token the two share for this call alone.
 */
export async function requestIdleStop(idle: WorkspaceIdle, health: Response, env: IdleEnv, now = Date.now(), send: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  if (!health.ok) throw new Error(`Runtime activity probe failed (${health.status})`)
  const body = asWorkerRecord(await health.json())
  if (body?.workspaceId !== idle.workspaceId) throw new Error("Runtime activity probe answered for another workspace")
  const idleBefore = workspaceIdleStopDue(body ?? {}, now, idle.idleMs)
  if (idleBefore === undefined) return undefined
  const response = await send(`${env.CONTROL_PLANE_URL?.replace(/\/+$/, "")}/internal/sandbox/idle-stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.IDLE_STOP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: idle.workspaceId, epoch: idle.epoch, idleBefore }),
    redirect: "manual",
  })
  if (!response.ok) throw new Error(`Idle stop failed (${response.status}): ${(await response.text()).slice(0, 500)}`)
  const stopped = asWorkerRecord(await response.json())
  return { checkpoint: typeof stopped?.checkpoint === "string" ? stopped.checkpoint : undefined }
}
