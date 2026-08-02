import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

export type SessionProjectionReason =
  | "session-created"
  | "message-checkpoint"
  | "repair"
  | "session-mutated"
  | "sse-gap"

type ProjectionAction = "register" | "checkpoint" | "repair"

type ProjectionInput = {
  workspaceId?: string
  sessionId?: string
  action: ProjectionAction
  reason: SessionProjectionReason
  serverUrl?: string
  expectedEventOrdinal?: number
  idempotencyKey?: string
  request?: typeof fetch
}

const pending = new Map<string, Promise<void>>()

function root(input?: string) {
  return normalizeUrl(input) ?? getClaxedoServerUrl()
}

function key(input: ProjectionInput) {
  return [
    input.action,
    input.workspaceId,
    input.sessionId,
    input.reason,
    input.expectedEventOrdinal ?? "",
    input.idempotencyKey ?? "",
  ].join("\0")
}

function endpoint(input: Required<Pick<ProjectionInput, "workspaceId" | "sessionId" | "action">> & Pick<ProjectionInput, "serverUrl">) {
  return new URL(
    `/api/control/workspaces/${encodeURIComponent(input.workspaceId)}/sessions/${encodeURIComponent(input.sessionId)}/${input.action}`,
    root(input.serverUrl),
  )
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function post(input: ProjectionInput) {
  if (!input.workspaceId || !input.sessionId) return
  const run = input.request ?? authFetch
  const body = {
    idempotencyKey: input.idempotencyKey ?? key(input),
    reason: input.reason,
    ...(input.expectedEventOrdinal === undefined ? {} : { expectedEventOrdinal: input.expectedEventOrdinal }),
  }
  for (const delay of [0, 1_000, 3_000]) {
    if (delay > 0) await sleep(delay)
    const res = await run(endpoint({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      action: input.action,
      serverUrl: input.serverUrl,
    }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
    if (res?.ok) return
  }
}

export function scheduleSessionProjectionPull(input: ProjectionInput) {
  if (!input.workspaceId || !input.sessionId) return
  const requestKey = key(input)
  const existing = pending.get(requestKey)
  if (existing) return existing
  const next = post(input).finally(() => {
    if (pending.get(requestKey) === next) pending.delete(requestKey)
  })
  pending.set(requestKey, next)
  return next
}
