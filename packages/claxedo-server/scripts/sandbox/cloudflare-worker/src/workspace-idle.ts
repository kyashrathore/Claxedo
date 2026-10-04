import { asWorkerRecord } from "./worker-json"

export const IDLE_CHECK = "checkWorkspaceIdle"
export const IDLE_CHECK_SECONDS = 30
/** Ten minutes of checks that all failed: keeping the container alive costs more than the SDK's own sleep would. */
export const IDLE_CHECK_FAILURE_LIMIT = 20
const DEFAULT_IDLE_MS = 600_000
// Longer than any checkpoint holds a runtime frozen: a drain plus the driver's 180 s backup deadline.
const FROZEN_DEADLINE_MS = 15 * 60_000

export type WorkspaceIdle = { workspaceId: string; epoch: number; port: number; idleMs: number; healthToken: string; failures?: number }

export type IdleEnv = { IDLE_STOP_TOKEN?: string; CONTROL_PLANE_URL?: string; WORKSPACE_IDLE_MS?: string }

/** The idle lifecycle a runtime's labels and this Worker's configuration describe, or `undefined` when they describe none. */
export function workspaceIdlePlacement(labels: Record<string, string>, port: number, env: IdleEnv): Omit<WorkspaceIdle, "healthToken"> | undefined {
  const epoch = Number(labels.epoch)
  const idleMs = Number(env.WORKSPACE_IDLE_MS ?? DEFAULT_IDLE_MS)
  if (!env.CONTROL_PLANE_URL || !env.IDLE_STOP_TOKEN || !labels.workspaceId || !Number.isSafeInteger(epoch) || epoch < 1) return undefined
  if (!Number.isSafeInteger(idleMs) || idleMs < IDLE_CHECK_SECONDS * 1000) return undefined
  return { workspaceId: labels.workspaceId, epoch, port, idleMs }
}

/**
 * Reads the runtime's own idle answer and, once it has been idle for the whole
 * window or held frozen past any checkpoint's deadline, asks the control plane
 * to settle this lease generation: it captures an idle runtime and stops the
 * lease, answers a lease it already stopped, and thaws a runtime a failed
 * capture left frozen. The answer names the checkpoint the stopped lease
 * references, or `undefined` when nothing is due. The request carries the
 * idle-stop token the two share for this call alone.
 */
export async function requestIdleStop(idle: WorkspaceIdle, health: Response, env: IdleEnv, now = Date.now(), send: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  if (!health.ok) throw new Error(`Runtime activity probe failed (${health.status})`)
  const body = asWorkerRecord(await health.json())
  if (body?.workspaceId !== idle.workspaceId) throw new Error("Runtime activity probe answered for another workspace")
  const idleBefore = now - idle.idleMs
  const idleDue = typeof body.idleSince === "number" && body.idleSince <= idleBefore
  const frozenDue = typeof body.frozenSince === "number" && body.frozenSince <= now - FROZEN_DEADLINE_MS
  if (!idleDue && !frozenDue) return undefined
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
