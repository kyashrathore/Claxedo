import { defaultHomeRegion, normalizeClaxedoRegion } from "../region"
import type { Workspace } from "../workspace-store"
import type { ControlPlaneAuthContext } from "./auth"
import { requireAuthority } from "./authority"
import type { ControlPlaneServices } from "./services"

class HostedSessionPullError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function requireSignedAuth(auth: ControlPlaneAuthContext | undefined) {
  if (auth?.mode === "signed") return auth
  throw new HostedSessionPullError(401, "signed_auth_required", "Signed auth is required")
}

function sessionStamp(input: Record<string, unknown>) {
  const time = rec(input.time)
  const createdAt = num(time?.created) ?? num(input.created_at)
  const updatedAt = num(time?.updated) ?? num(input.updated_at) ?? createdAt
  return {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function sessionVisibility(input: unknown) {
  const row = rec(input)
  if (!row) return
  const sessionId = txt(row.id)
  if (!sessionId) return
  const title = txt(row.title) ?? txt(row.slug)
  return {
    sessionId,
    ...(title ? { title } : {}),
    ...sessionStamp(row),
  }
}

function messagesPayload(input: unknown) {
  if (Array.isArray(input)) return { messages: input, maxEventOrdinal: undefined }
  const row = rec(input)
  return {
    messages: Array.isArray(row?.messages) ? row.messages : [],
    maxEventOrdinal: typeof row?.maxEventOrdinal === "number" && Number.isFinite(row.maxEventOrdinal)
      ? row.maxEventOrdinal
      : undefined,
  }
}

function sessionPayloadId(input: unknown) {
  const row = rec(input)
  return txt(row?.id) ?? txt(row?.sessionId) ?? txt(row?.sessionID)
}

function assertPulledSession(input: unknown, sessionId: string) {
  if (sessionPayloadId(input) === sessionId) return
  throw new HostedSessionPullError(409, "workspace_runtime_session_mismatch", "Workspace runtime session identity does not match requested session")
}

function runtimePath(path: string, query?: Record<string, string | undefined>) {
  const url = new URL(path, "http://workspace-runtime.local")
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}`
}

async function hostedWorkspaceForPull(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  workspaceId: string,
) {
  const signed = requireSignedAuth(auth)
  const authority = requireAuthority(services)
  const opened = await authority.openWorkspace(signed, { workspaceId })
  const workspace = rec(rec(opened)?.workspace)
  const orgId = txt(workspace?.org_id)
    ?? txt(workspace?.orgId)
    ?? (typeof authority.resolveOrgId === "function" ? txt(await authority.resolveOrgId(signed)) : undefined)
  const stamp = Date.now()
  return {
    id: workspaceId,
    ...(orgId ? { org_id: orgId } : {}),
    directory: `workspace:${workspaceId}`,
    kind: "cloud",
    status: "ready",
    created_at: num(workspace?.created_at) ?? num(workspace?.createdAt) ?? stamp,
    updated_at: num(workspace?.updated_at) ?? num(workspace?.updatedAt) ?? stamp,
  } satisfies Workspace
}

async function runtimeFetch(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: {
    workspaceId: string
    ws: Workspace
    path: string
  },
) {
  const provider = services.relay.provider
  if (!provider) {
    throw new HostedSessionPullError(503, "workspace_runtime_unavailable", "Workspace runtime pull transport is not configured")
  }
  const hostManager = services.sandbox.sandboxManager
  if (!hostManager) {
    throw new HostedSessionPullError(503, "sandbox_unavailable", "Sandbox manager is not configured")
  }
  const target = await hostManager.target(input.workspaceId).catch(() => undefined)
  if (target?.status !== "ready") {
    throw new HostedSessionPullError(409, "cloud_runtime_unavailable", "Cloud runtime is unavailable")
  }
  const orgId = input.ws.org_id
  if (!orgId) {
    throw new HostedSessionPullError(409, "workspace_org_required", "Workspace is missing org identity for runtime token minting")
  }
  const token = await provider.mintRuntimeAccessToken({
    workspaceId: input.workspaceId,
    hostId: target.hostId,
    subject: auth?.mode === "signed" ? auth.user.subject : "control-plane",
    orgId,
    role: "owner",
    ttlMs: 10 * 60_000,
  })
  const relayUrl = await provider.getRelayEndpoint(
    input.workspaceId,
    normalizeClaxedoRegion(target.homeRegion, services.defaultHomeRegion ?? defaultHomeRegion()),
  )
  return await fetch(`${relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.workspaceId)}${input.path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token.token}`,
      "x-opencode-directory": `workspace:${input.workspaceId}`,
    },
  })
}

async function runtimeJson<T>(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: {
    workspaceId: string
    ws: Workspace
    path: string
  },
) {
  const res = await runtimeFetch(services, auth, input)
  if (res.ok) return await res.json() as T
  throw new HostedSessionPullError(res.status, "workspace_runtime_pull_failed", await res.text().catch(() => "") || `Workspace runtime pull failed: ${res.status}`)
}

async function verifiedRuntimeJson<T>(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: {
    workspaceId: string
    ws: Workspace
    path: string
  },
) {
  const health = await runtimeJson<Record<string, unknown>>(services, auth, {
    ...input,
    path: "/api/wr/health",
  })
  if (txt(health.workspaceId) !== input.workspaceId) {
    throw new HostedSessionPullError(409, "workspace_runtime_mismatch", "Workspace runtime identity does not match requested workspace")
  }
  return await runtimeJson<T>(services, auth, input)
}

export async function pullHostedControlSession(
  services: ControlPlaneServices,
  _options: unknown,
  auth: ControlPlaneAuthContext | undefined,
  input: { workspaceId: string; sessionId: string },
) {
  const signed = requireSignedAuth(auth)
  const ws = await hostedWorkspaceForPull(services, signed, input.workspaceId)
  const session = await verifiedRuntimeJson<unknown>(services, signed, {
    workspaceId: ws.id,
    ws,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}`),
  })
  assertPulledSession(session, input.sessionId)
  await services.projectionStore.sync_session_meta(ws, session)
  const visibility = sessionVisibility(session)
  if (visibility) {
    await requireAuthority(services).upsertSessionVisibility(signed, {
      workspaceId: ws.id,
      sessions: [visibility],
    })
  }
  return {
    ok: true,
    sessionId: input.sessionId,
  }
}

export async function pullHostedControlSessionMessages(
  services: ControlPlaneServices,
  _options: unknown,
  auth: ControlPlaneAuthContext | undefined,
  input: { workspaceId: string; sessionId: string; expectedEventOrdinal?: number },
) {
  const signed = requireSignedAuth(auth)
  const ws = await hostedWorkspaceForPull(services, signed, input.workspaceId)
  const currentOrdinal = services.projectionStore.read_session_max_event_ordinal(input.sessionId)
  if (input.expectedEventOrdinal !== undefined && input.expectedEventOrdinal < currentOrdinal) {
    return { ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal }
  }
  const pulled = await verifiedRuntimeJson<unknown>(services, signed, {
    workspaceId: ws.id,
    ws,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}/message`, { snapshot: "1" }),
  })
  const payload = messagesPayload(pulled)
  const currentMessages = services.projectionStore.read_session_messages(input.sessionId)
  if (payload.maxEventOrdinal !== undefined && payload.maxEventOrdinal < currentOrdinal) {
    return { ok: true, skipped: true, reason: "older_snapshot_ordinal", currentOrdinal, snapshotOrdinal: payload.maxEventOrdinal }
  }
  if (
    payload.maxEventOrdinal !== undefined &&
    payload.maxEventOrdinal === currentOrdinal &&
    currentMessages.length > 0 &&
    payload.messages.length <= currentMessages.length
  ) {
    return { ok: true, skipped: true, reason: "older_snapshot_ordinal", currentOrdinal, snapshotOrdinal: payload.maxEventOrdinal }
  }
  if (payload.maxEventOrdinal === undefined && payload.messages.length < currentMessages.length) {
    return { ok: true, skipped: true, reason: "shorter_snapshot", currentMessages: currentMessages.length, snapshotMessages: payload.messages.length }
  }
  if (payload.maxEventOrdinal === undefined) {
    await services.projectionStore.sync_session_messages(ws, input.sessionId, payload.messages)
  } else {
    await services.projectionStore.sync_session_messages(ws, input.sessionId, payload.messages, {
      maxEventOrdinal: payload.maxEventOrdinal,
    })
  }
  await requireAuthority(services).syncSessionMessages(signed, {
    workspaceId: ws.id,
    sessionId: input.sessionId,
    messages: payload.messages,
  })
  return {
    ok: true,
    sessionId: input.sessionId,
    messages: payload.messages.length,
    ...(payload.maxEventOrdinal === undefined ? {} : { maxEventOrdinal: payload.maxEventOrdinal }),
  }
}
