import { asWorkerRecord } from "./worker-json"

export const IDLE_CHECK = "checkWorkspaceIdle"
export const IDLE_CHECK_SECONDS = 30
const DEFAULT_IDLE_MS = 600_000

export type WorkspaceIdle = { workspaceId: string; epoch: number; port: number; idleMs: number; healthToken: string }

export type IdleEnv = { API_TOKEN: string; CONTROL_PLANE_URL?: string; WORKSPACE_IDLE_MS?: string }

/** The idle lifecycle a runtime's labels and this Worker's configuration describe, or `undefined` when they describe none. */
export function workspaceIdlePlacement(labels: Record<string, string>, port: number, env: IdleEnv): Omit<WorkspaceIdle, "healthToken"> | undefined {
  const epoch = Number(labels.epoch)
  const idleMs = Number(env.WORKSPACE_IDLE_MS ?? DEFAULT_IDLE_MS)
  if (!env.CONTROL_PLANE_URL || !labels.workspaceId || !Number.isSafeInteger(epoch) || epoch < 1) return undefined
  if (!Number.isSafeInteger(idleMs) || idleMs < IDLE_CHECK_SECONDS * 1000) return undefined
  return { workspaceId: labels.workspaceId, epoch, port, idleMs }
}

/**
 * Reads the runtime's own idle answer and, once it has been idle for the whole
 * window, asks the control plane to checkpoint and stop this lease generation.
 * The request carries this Worker's API token, which the control plane already
 * holds to call the Worker; the runtime refuses the freeze if work started since.
 */
export async function requestIdleStop(idle: WorkspaceIdle, health: Response, env: IdleEnv, now = Date.now(), send: (url: string, init: RequestInit) => Promise<Response> = fetch) {
  if (!health.ok) throw new Error(`Runtime activity probe failed (${health.status})`)
  const body = asWorkerRecord(await health.json())
  if (body?.workspaceId !== idle.workspaceId) throw new Error("Runtime activity probe answered for another workspace")
  const idleBefore = now - idle.idleMs
  if (typeof body.idleSince !== "number" || body.idleSince > idleBefore) return false
  const response = await send(`${env.CONTROL_PLANE_URL?.replace(/\/+$/, "")}/internal/sandbox/idle-stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: idle.workspaceId, epoch: idle.epoch, idleBefore }),
    redirect: "manual",
  })
  if (!response.ok) throw new Error(`Idle stop failed (${response.status}): ${(await response.text()).slice(0, 500)}`)
  return true
}
