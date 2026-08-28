import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

export type PrivateSessionReservation = {
  operationId: string
  sessionId: string
  workspaceId: string
}

export type PrivateSessionForkClient = {
  fork(
    input: { sessionID: string; messageID?: string; id?: string },
    options?: { headers?: Record<string, string> },
  ): Promise<{ data?: { id: string } }>
}

export async function reservePrivateSession(input: {
  workspaceId: string
  kind: "create" | "fork"
  parentSessionId?: string
  title?: string
  serverUrl?: string
  request?: typeof fetch
  sessionId?: string
  operationId?: string
}): Promise<PrivateSessionReservation> {
  const sessionId = input.sessionId ?? randomIdentifier("ses")
  const operationId = input.operationId ?? randomIdentifier("session_registration")
  const baseUrl = normalizeUrl(input.serverUrl) ?? getClaxedoServerUrl()
  const response = await (input.request ?? authFetch)(
    new URL("/api/control/session-registrations/reserve", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operationId,
        sessionId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.title ? { title: input.title } : {}),
      }),
    },
  )
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { message?: unknown } } | undefined
    throw new Error(typeof body?.error?.message === "string" ? body.error.message : `Session reservation failed (${response.status})`)
  }
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
  if (
    body?.operationId !== operationId
    || body.sessionId !== sessionId
    || body.workspaceId !== input.workspaceId
    || body.state !== "reserved"
  ) throw new Error("Session reservation response did not match the requested immutable intent")
  return { operationId, sessionId, workspaceId: input.workspaceId }
}

export async function forkSessionWithReservation(input: {
  client: PrivateSessionForkClient
  sessionId: string
  messageId?: string
  managed: boolean
  workspaceId?: string
  serverUrl?: string
  request?: typeof fetch
}) {
  if (!input.managed) {
    return await input.client.fork({
      sessionID: input.sessionId,
      ...(input.messageId ? { messageID: input.messageId } : {}),
    })
  }
  const workspaceId = input.workspaceId?.trim()
  if (!workspaceId) throw new Error("Signed session fork requires an authoritative workspace id")
  const reservation = await reservePrivateSession({
    workspaceId,
    kind: "fork",
    parentSessionId: input.sessionId,
    ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
    ...(input.request ? { request: input.request } : {}),
  })
  return await input.client.fork(
    {
      sessionID: input.sessionId,
      id: reservation.sessionId,
      ...(input.messageId ? { messageID: input.messageId } : {}),
    },
    { headers: { "x-claxedo-session-registration-operation": reservation.operationId } },
  )
}

function randomIdentifier(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}
