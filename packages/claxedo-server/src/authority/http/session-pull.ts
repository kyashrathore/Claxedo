import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneAuthContext, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../services"
import { ControlPlaneProtocolError, txt, type ControlPlaneHttpOptions } from "./protocol"
import { runtimeJson, runtimePath, verifiedRuntimeJson } from "./runtime-transport"
import type { RelayRole } from "@claxedo/workspace-relay"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"

function workspaceRoleAllowsWrite(role: unknown) {
  return role === "editor" || role === "admin" || role === "owner"
}

export async function resolveSessionGateway(
  services: ControlPlaneServices,
  sessionId: string,
  auth?: SignedControlPlaneAuth,
) {
  const meta = await services.projectionStore.session_meta(sessionId)
  if (!meta || meta.host !== "workspace") throw new ControlPlaneProtocolError(404, "session_not_found", "Machine session not found")
  const ws = meta.workspaceID
    ? await resolveWorkspace({ workspaceId: meta.workspaceID })
    : meta.directory
      ? await resolveWorkspace({ directory: meta.directory })
      : undefined
  if (auth) {
    const workspaceId = ws?.id ?? meta.workspaceID
    if (!workspaceId) throw new ControlPlaneProtocolError(404, "workspace_not_found", "Machine workspace not found")
    await requireAuthority(services).authorizeSessionRead(auth, { sessionId, workspaceId })
  }
  return {
    gatewayUrl: null,
    workspaceId: ws?.id ?? meta.workspaceID ?? null,
    directory: auth ? null : meta.directory,
    harnessHost: "workspace" as const,
  }
}

export async function pullControlSession(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  auth: ControlPlaneAuthContext | undefined,
  input: { workspaceId: string; sessionId: string },
) {
  const scope = await workspaceForPull(services, auth, input.workspaceId, input.sessionId)
  if (auth?.mode === "signed" && !workspaceRoleAllowsWrite(scope.authorityRole)) {
    throw new ControlPlaneProtocolError(403, "workspace_authorization_denied", "Workspace write authority is required")
  }
  const { ws } = scope
  const session = await verifiedRuntimeJson(services, options, {
    workspaceId: ws.id,
    ws,
    ...(scope.authorityWorkspace ? { authorityWorkspace: scope.authorityWorkspace } : {}),
    ...(scope.authorityRole ? { authorityRole: scope.authorityRole } : {}),
    auth,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}`),
  })
  await syncPulledSessionMetadata(services, auth, ws, input.sessionId, session)
  return {
    ok: true,
    sessionId: input.sessionId,
  }
}

export async function pullControlSessionMessages(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  auth: ControlPlaneAuthContext | undefined,
  input: { workspaceId: string; sessionId: string; expectedEventOrdinal?: number },
) {
  const scope = await workspaceForPull(services, auth, input.workspaceId, input.sessionId)
  const { ws } = scope
  if (auth?.mode === "signed") {
    await requireAuthority(services).authorizeSessionWrite(auth, {
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
    })
  }
  const currentOrdinal = services.projectionStore.read_session_max_event_ordinal(input.sessionId)
  if (input.expectedEventOrdinal !== undefined && input.expectedEventOrdinal < currentOrdinal) {
    return { ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal }
  }
  const pulled = await verifiedRuntimeJson(services, options, {
    workspaceId: ws.id,
    ws,
    ...(scope.authorityWorkspace ? { authorityWorkspace: scope.authorityWorkspace } : {}),
    ...(scope.authorityRole ? { authorityRole: scope.authorityRole } : {}),
    auth,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}/message`, { snapshot: "1" }),
  })
  const payload = messagesPayload(pulled)
  assertPulledSession(payload.session, input.sessionId)
  const syncAuthority = async () => {
    if (auth?.mode !== "signed") return
    const intakeReady = await runtimeJson(services, options, {
      workspaceId: ws.id,
      ws,
      ...(scope.authorityWorkspace ? { authorityWorkspace: scope.authorityWorkspace } : {}),
      ...(scope.authorityRole ? { authorityRole: scope.authorityRole } : {}),
      auth,
      path: "/session/status",
    }).then(
      (status) => sessionIsIdle(status, input.sessionId),
      () => false,
    )
    await requireAuthority(services).syncSessionMessages(auth, {
      workspaceId: ws.id,
      sessionId: input.sessionId,
      messages: payload.messages,
      maxEventOrdinal: payload.maxEventOrdinal
        ?? services.projectionStore.read_session_max_event_ordinal(input.sessionId),
      ...(payload.fencingToken === undefined ? {} : { fencingToken: payload.fencingToken }),
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
    await syncPulledSessionMetadata(services, auth, ws, input.sessionId, payload.session)
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
    ? await services.projectionStore.sync_session_messages(ws, input.sessionId, payload.messages)
    : await services.projectionStore.sync_session_messages(ws, input.sessionId, payload.messages, {
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
  await syncAuthority()
  await syncPulledSessionMetadata(services, auth, ws, input.sessionId, payload.session)
  return {
    ok: true,
    sessionId: input.sessionId,
    messages: payload.messages.length,
    ...(payload.maxEventOrdinal === undefined ? {} : { maxEventOrdinal: payload.maxEventOrdinal }),
  }
}

async function syncPulledSessionMetadata(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  ws: Workspace,
  sessionId: string,
  session: unknown,
) {
  assertPulledSession(session, sessionId)
  await services.projectionStore.sync_session_meta(ws, session)
  await upsertSignedSessionVisibility(services, auth, ws, [session])
}

async function workspaceForPull(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  workspaceId: string,
  sessionId: string,
) {
  const opened = auth?.mode === "signed"
    ? await requireAuthority(services).openWorkspace(auth, { workspaceId })
    : undefined
  const hit = await resolveWorkspace({ workspaceId })
  const session = await services.projectionStore.session_meta(sessionId)
  if (session && (session.workspaceID ? session.workspaceID !== workspaceId : session.directory !== hit?.directory)) {
    throw new ControlPlaneProtocolError(
      409,
      "workspace_runtime_session_mismatch",
      "Stored session does not belong to the requested workspace",
    )
  }
  if (hit) {
    const authoritativeOrgId = txt(opened?.workspace?.org_id)
    const authoritativeProjectId = txt(opened?.workspace?.project_id)
    if (authoritativeOrgId && hit.org_id && hit.org_id !== authoritativeOrgId) {
      throw new ControlPlaneProtocolError(
        409,
        "workspace_tenant_conflict",
        "Local workspace organization does not match workspace authority",
      )
    }
    if (authoritativeProjectId && hit.project_id && hit.project_id !== authoritativeProjectId) {
      throw new ControlPlaneProtocolError(
        409,
        "workspace_project_conflict",
        "Local workspace project does not match workspace authority",
      )
    }
    const ws = authoritativeOrgId && !hit.org_id ? { ...hit, org_id: authoritativeOrgId } : hit
    return { ws, authorityWorkspace: opened?.workspace, authorityRole: relayRole(opened?.role) }
  }
  if (auth?.mode !== "signed") {
    throw new ControlPlaneProtocolError(404, "workspace_not_found", `workspace ${workspaceId} not found`)
  }
  const authority = requireAuthority(services)
  const orgId = txt(opened?.workspace?.org_id)
    ?? (typeof authority.resolveOrgId === "function" ? txt(await authority.resolveOrgId(auth)) : undefined)
  const projectId = txt(opened?.workspace?.project_id)
  const stamp = Date.now()
  const ws = {
    id: workspaceId,
    ...(orgId ? { org_id: orgId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    directory: `workspace:${workspaceId}`,
    kind: "cloud",
    created_at: stamp,
    updated_at: stamp,
  } satisfies Workspace
  return { ws, authorityWorkspace: opened?.workspace, authorityRole: relayRole(opened?.role) }
}

function relayRole(value: unknown): RelayRole | undefined {
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
}

/**
 * Only the update stamp travels to the authority: a session's creation time is
 * owned by its registration (`registerRuntimeSession`), and both session
 * authorities reject a visibility upsert whose `createdAt` disagrees with it.
 * The runtime's own `time.created` is a different clock instant, so it never
 * agrees.
 */
function sessionStamp(input: Record<string, unknown>) {
  const time = asRecord(input.time)
  const updatedAt = asFiniteNumber(time?.updated)
    ?? asFiniteNumber(input.updated_at)
    ?? asFiniteNumber(time?.created)
    ?? asFiniteNumber(input.created_at)
  return updatedAt === undefined ? {} : { updatedAt }
}

function sessionVisibility(_ws: Workspace, input: unknown) {
  const row = asRecord(input)
  if (!row) return undefined
  const sessionId = txt(row.id)
  if (!sessionId) return undefined
  const title = txt(row.title) ?? txt(row.slug)
  return {
    sessionId,
    ...(title ? { title } : {}),
    ...sessionStamp(row),
  }
}

function messagesPayload(input: unknown) {
  const row = asRecord(input)
  if (!row || !Array.isArray(row.messages) || !asRecord(row.session)) {
    throw new ControlPlaneProtocolError(
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
    throw new ControlPlaneProtocolError(
      502,
      "workspace_runtime_snapshot_invalid",
      "Workspace runtime returned an invalid message snapshot",
    )
  }
  if (
    fencingToken !== undefined
    && (typeof fencingToken !== "number" || !Number.isSafeInteger(fencingToken) || fencingToken <= 0)
  ) {
    throw new ControlPlaneProtocolError(
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
  const row = asRecord(input)
  return txt(row?.id) ?? txt(row?.sessionId) ?? txt(row?.sessionID)
}

function assertPulledSession(input: unknown, sessionId: string) {
  if (sessionPayloadId(input) === sessionId) return undefined
  throw new ControlPlaneProtocolError(
    409,
    "workspace_runtime_session_mismatch",
    "Workspace runtime session identity does not match requested session",
  )
}

function sessionIsIdle(input: unknown, sessionId: string) {
  const statuses = asRecord(input)
  if (!statuses) return false
  if (!(sessionId in statuses)) return true
  return asRecord(statuses[sessionId])?.type === "idle"
}

async function upsertSignedSessionVisibility(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  ws: Workspace,
  sessions: unknown[],
) {
  if (auth?.mode !== "signed") return
  await requireAuthority(services).upsertSessionVisibility(auth, {
    workspaceId: ws.id,
    sessions: sessions.flatMap((session) => {
      const visibility = sessionVisibility(ws, session)
      return visibility ? [visibility] : []
    }),
  })
}
