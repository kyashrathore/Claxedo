import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { RelayRole } from "@claxedo/workspace-relay"
import type { ControlPlaneServices } from "./services"
import { resolveWorkspaceRuntimeTarget } from "./runtime-target"
import { WORKSPACE_RUNTIME_IDENTITY_PATH } from "@claxedo/server-core/platform/governance/route-ownership"

function workspaceRoleAllowsWrite(role: unknown) {
  return role === "editor" || role === "admin" || role === "owner"
}

export class HostedSessionPullError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function rec(input: unknown) {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
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

function relayRole(value: unknown): RelayRole | undefined {
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
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
  const row = rec(input)
  if (!row || !Array.isArray(row.messages) || !rec(row.session)) {
    throw new HostedSessionPullError(
      502,
      "workspace_runtime_snapshot_invalid",
      "Workspace runtime returned an invalid message snapshot",
    )
  }
  const maxEventOrdinal = row.maxEventOrdinal
  const fencingToken = row.fencingToken
  if (
    maxEventOrdinal !== undefined
    && (typeof maxEventOrdinal !== "number" || !Number.isInteger(maxEventOrdinal) || maxEventOrdinal < 0)
  ) {
    throw new HostedSessionPullError(
      502,
      "workspace_runtime_snapshot_invalid",
      "Workspace runtime returned an invalid message snapshot",
    )
  }
  if (
    fencingToken !== undefined
    && (typeof fencingToken !== "number" || !Number.isSafeInteger(fencingToken) || fencingToken <= 0)
  ) {
    throw new HostedSessionPullError(
      502,
      "workspace_runtime_snapshot_invalid",
      "Workspace runtime returned an invalid message snapshot fence",
    )
  }
  return {
    messages: row.messages,
    maxEventOrdinal,
    fencingToken,
    session: row.session,
  }
}

function sessionPayloadId(input: unknown) {
  const row = rec(input)
  return txt(row?.id) ?? txt(row?.sessionId) ?? txt(row?.sessionID)
}

function assertPulledSession(input: unknown, sessionId: string) {
  if (sessionPayloadId(input) === sessionId) return
  throw new HostedSessionPullError(
    409,
    "workspace_runtime_session_mismatch",
    "Workspace runtime session identity does not match requested session",
  )
}

function sessionIsIdle(input: unknown, sessionId: string) {
  const statuses = rec(input)
  if (!statuses) return false
  if (!(sessionId in statuses)) return true
  return rec(statuses[sessionId])?.type === "idle"
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
  const role = relayRole(rec(opened)?.role)
  if (!role) throw new HostedSessionPullError(403, "workspace_authorization_denied", "Workspace access is denied")
  const workspace = rec(rec(opened)?.workspace)
  const orgId =
    txt(workspace?.org_id) ??
    txt(workspace?.orgId) ??
    (typeof authority.resolveOrgId === "function" ? txt(await authority.resolveOrgId(signed)) : undefined)
  const stamp = Date.now()
  const ws = {
    id: workspaceId,
    ...(orgId ? { org_id: orgId } : {}),
    directory: `workspace:${workspaceId}`,
    kind: "cloud",
    status: "ready",
    created_at: num(workspace?.created_at) ?? num(workspace?.createdAt) ?? stamp,
    updated_at: num(workspace?.updated_at) ?? num(workspace?.updatedAt) ?? stamp,
  } satisfies Workspace
  return { workspaceId, ws, workspace, role }
}

async function runtimeFetch(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: {
    workspaceId: string
    ws: Workspace
    hostId: string
    homeRegion: ClaxedoRegion
    role: RelayRole
    path: string
  },
) {
  const provider = services.relay.provider
  if (!provider) {
    throw new HostedSessionPullError(
      503,
      "workspace_runtime_unavailable",
      "Workspace runtime pull transport is not configured",
    )
  }
  const orgId = input.ws.org_id
  if (!orgId) {
    throw new HostedSessionPullError(
      409,
      "workspace_org_required",
      "Workspace is missing org identity for runtime token minting",
    )
  }
  const signed = requireSignedAuth(auth)
  const token = await provider.mintRuntimeAccessToken({
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    principalKind: "user",
    auth: signed,
    ...await resolveRuntimeActor(requireAuthority(services), signed),
    orgId,
    role: input.role,
    ttlMs: 10 * 60_000,
  })
  const relayUrl = await provider.getRelayEndpoint(input.workspaceId, input.homeRegion)
  return await fetch(
    `${relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.workspaceId)}${input.path}`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.token}`,
        "x-opencode-directory": `workspace:${input.workspaceId}`,
      },
    },
  )
}

async function runtimeJson<T>(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: {
    workspaceId: string
    ws: Workspace
    hostId: string
    homeRegion: ClaxedoRegion
    role: RelayRole
    path: string
  },
) {
  const res = await runtimeFetch(services, auth, input)
  if (res.ok) return (await res.json()) as T
  throw new HostedSessionPullError(
    res.status,
    "workspace_runtime_pull_failed",
    (await res.text().catch(() => "")) || `Workspace runtime pull failed: ${res.status}`,
  )
}

async function verifiedRuntimeJson<T>(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: {
    workspaceId: string
    ws: Workspace
    hostId: string
    homeRegion: ClaxedoRegion
    role: RelayRole
    path: string
  },
) {
  const health = await runtimeJson<Record<string, unknown>>(services, auth, {
    ...input,
    path: WORKSPACE_RUNTIME_IDENTITY_PATH,
  })
  if (txt(health.workspaceId) !== input.workspaceId) {
    throw new HostedSessionPullError(
      409,
      "workspace_runtime_mismatch",
      "Workspace runtime identity does not match requested workspace",
    )
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
  const workspace = await hostedWorkspaceForPull(services, signed, input.workspaceId)
  if (!workspaceRoleAllowsWrite(workspace.role)) {
    throw new HostedSessionPullError(403, "workspace_authorization_denied", "Workspace write authority is required")
  }
  const target = {
    ...workspace,
    ...await resolveWorkspaceRuntimeTarget(services, signed, workspace),
  }
  const session = await verifiedRuntimeJson<unknown>(services, signed, {
    ...target,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}`),
  })
  await syncHostedSessionMetadata(services, signed, target, input.sessionId, session)
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
  const workspace = await hostedWorkspaceForPull(services, signed, input.workspaceId)
  await requireAuthority(services).authorizeSessionWrite(signed, {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
  })
  const currentOrdinal = services.projectionStore.read_session_max_event_ordinal(input.sessionId)
  if (input.expectedEventOrdinal !== undefined && input.expectedEventOrdinal < currentOrdinal) {
    return { ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal }
  }
  const target = {
    ...workspace,
    ...await resolveWorkspaceRuntimeTarget(services, signed, workspace),
  }
  const pulled = await verifiedRuntimeJson<unknown>(services, signed, {
    ...target,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}/message`, { snapshot: "1" }),
  })
  const payload = messagesPayload(pulled)
  assertPulledSession(payload.session, input.sessionId)
  const syncAuthority = async (messages: unknown[], maxEventOrdinal: number, fencingToken?: number) => {
    const intakeReady = await runtimeJson<unknown>(services, signed, {
      ...target,
      path: "/session/status",
    }).then(
      (status) => sessionIsIdle(status, input.sessionId),
      () => false,
    )
    await requireAuthority(services).syncSessionMessages(signed, {
      workspaceId: target.workspaceId,
      sessionId: input.sessionId,
      messages,
      maxEventOrdinal,
      ...(fencingToken === undefined ? {} : { fencingToken }),
      intakeReady,
    })
  }
  const currentMessages = services.projectionStore.read_session_messages(input.sessionId)
  if (payload.maxEventOrdinal !== undefined && payload.maxEventOrdinal < currentOrdinal) {
    return {
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal,
      snapshotOrdinal: payload.maxEventOrdinal,
    }
  }
  if (
    payload.maxEventOrdinal !== undefined &&
    payload.maxEventOrdinal === currentOrdinal &&
    currentMessages.length > 0 &&
    payload.messages.length <= currentMessages.length
  ) {
    await syncHostedSessionMetadata(services, signed, target, input.sessionId, payload.session)
    return {
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal,
      snapshotOrdinal: payload.maxEventOrdinal,
    }
  }
  if (payload.maxEventOrdinal === undefined && payload.messages.length < currentMessages.length) {
    return {
      ok: true,
      skipped: true,
      reason: "shorter_snapshot",
      currentMessages: currentMessages.length,
      snapshotMessages: payload.messages.length,
    }
  }
  const applied = payload.maxEventOrdinal === undefined
    ? await services.projectionStore.sync_session_messages(target.ws, input.sessionId, payload.messages)
    : await services.projectionStore.sync_session_messages(target.ws, input.sessionId, payload.messages, {
      maxEventOrdinal: payload.maxEventOrdinal,
    })
  if (applied === false) {
    const canonicalOrdinal = services.projectionStore.read_session_max_event_ordinal(input.sessionId)
    return {
      ok: true,
      skipped: true,
      reason: "older_snapshot_ordinal",
      currentOrdinal: canonicalOrdinal,
      ...(payload.maxEventOrdinal === undefined ? {} : { snapshotOrdinal: payload.maxEventOrdinal }),
    }
  }
  await syncAuthority(
    payload.messages,
    payload.maxEventOrdinal ?? services.projectionStore.read_session_max_event_ordinal(input.sessionId),
    payload.fencingToken,
  )
  await syncHostedSessionMetadata(services, signed, target, input.sessionId, payload.session)
  return {
    ok: true,
    sessionId: input.sessionId,
    messages: payload.messages.length,
    ...(payload.maxEventOrdinal === undefined ? {} : { maxEventOrdinal: payload.maxEventOrdinal }),
  }
}

async function syncHostedSessionMetadata(
  services: ControlPlaneServices,
  auth: ReturnType<typeof requireSignedAuth>,
  target: { workspaceId: string; ws: Workspace },
  sessionId: string,
  session: unknown,
) {
  assertPulledSession(session, sessionId)
  await services.projectionStore.sync_session_meta(target.ws, session)
  const visibility = sessionVisibility(session)
  if (!visibility) return
  await requireAuthority(services).upsertSessionVisibility(auth, {
    workspaceId: target.workspaceId,
    sessions: [visibility],
  })
}
