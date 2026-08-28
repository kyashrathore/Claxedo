import { resolveHarnessHostForRequest } from "@claxedo/server-core/session/harness/resolution"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneAuthContext, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneServices } from "../services"
import { ControlPlaneProtocolError, num, rec, txt, type ControlPlaneHttpOptions } from "./protocol"
import { runtimeJson, runtimePath, verifiedRuntimeJson } from "./runtime-transport"
import type { RelayRole } from "@claxedo/workspace-relay"

export async function resolveSessionGateway(
  services: ControlPlaneServices,
  sessionId: string,
  auth?: SignedControlPlaneAuth,
) {
  const meta = await services.projectionStore.session_meta(sessionId)
  if (!meta) {
    return {
      gatewayUrl: null,
      workspaceId: null,
      directory: null,
      harnessHost: "central" as const,
    }
  }
  const ws = meta.workspaceID
    ? await resolveWorkspace({ workspaceId: meta.workspaceID })
    : meta.directory
      ? await resolveWorkspace({ directory: meta.directory })
      : undefined
  const harnessHost =
    meta.host ??
    (await resolveHarnessHostForRequest({
      workspaceId: meta.workspaceID ?? undefined,
      directory: meta.directory ?? undefined,
      sessionId,
    }))
  if (!ws || ws.kind !== "cloud") {
    return {
      gatewayUrl: null,
      workspaceId: meta.workspaceID ?? null,
      directory: auth ? null : meta.directory,
      harnessHost,
    }
  }
  if (auth) {
    await requireAuthority(services).authorizeSessionRead(auth, {
      sessionId,
      workspaceId: ws.id,
    })
  }
  if (harnessHost === "central") {
    return {
      gatewayUrl: null,
      workspaceId: ws.id,
      directory: auth ? null : meta.directory,
      harnessHost,
    }
  }
  return {
    gatewayUrl: null,
    workspaceId: ws.id,
    directory: auth ? null : meta.directory,
    harnessHost,
  }
}

export async function pullControlSession(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  auth: ControlPlaneAuthContext | undefined,
  input: { workspaceId: string; sessionId: string },
) {
  const scope = await workspaceForPull(services, auth, input.workspaceId)
  const { ws } = scope
  const session = await verifiedRuntimeJson<unknown>(services, options, {
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
  const scope = await workspaceForPull(services, auth, input.workspaceId)
  const { ws } = scope
  const currentOrdinal = services.projectionStore.read_session_max_event_ordinal(input.sessionId)
  if (input.expectedEventOrdinal !== undefined && input.expectedEventOrdinal < currentOrdinal) {
    return { ok: true, skipped: true, reason: "older_expected_ordinal", currentOrdinal }
  }
  const pulled = await verifiedRuntimeJson<unknown>(services, options, {
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
    const intakeReady = await runtimeJson<unknown>(services, options, {
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
    while (true) {
      const maxEventOrdinal = services.projectionStore.read_session_max_event_ordinal(input.sessionId)
      await requireAuthority(services).syncSessionMessages(auth, {
        workspaceId: ws.id,
        sessionId: input.sessionId,
        messages: services.projectionStore.read_session_messages(input.sessionId),
        maxEventOrdinal,
        intakeReady,
      })
      if (services.projectionStore.read_session_max_event_ordinal(input.sessionId) === maxEventOrdinal) return
    }
  }
  const currentMessages = services.projectionStore.read_session_messages(input.sessionId)
  if (payload.maxEventOrdinal !== undefined && payload.maxEventOrdinal < currentOrdinal) {
    await syncAuthority()
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
    await syncAuthority()
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
    await syncAuthority()
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
    await syncAuthority()
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
) {
  const opened = auth?.mode === "signed"
    ? await requireAuthority(services).openWorkspace(auth, { workspaceId })
    : undefined
  const hit = await resolveWorkspace({ workspaceId })
  if (hit) {
    const authoritativeOrgId = txt(opened?.workspace?.org_id)
    const ws = authoritativeOrgId && !hit.org_id ? { ...hit, org_id: authoritativeOrgId } : hit
    return { ws, authorityWorkspace: opened?.workspace, authorityRole: relayRole(opened?.role) }
  }
  if (auth?.mode !== "signed") {
    throw new ControlPlaneProtocolError(404, "workspace_not_found", `workspace ${workspaceId} not found`)
  }
  const authority = requireAuthority(services)
  const orgId = typeof authority.resolveOrgId === "function" ? txt(await authority.resolveOrgId(auth)) : undefined
  const stamp = Date.now()
  const ws = {
    id: workspaceId,
    ...(orgId ? { org_id: orgId } : {}),
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

function sessionStamp(input: Record<string, unknown>) {
  const time = rec(input.time)
  const createdAt = num(time?.created) ?? num(input.created_at)
  const updatedAt = num(time?.updated) ?? num(input.updated_at) ?? createdAt
  return {
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function sessionVisibility(_ws: Workspace, input: unknown) {
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
    throw new ControlPlaneProtocolError(
      502,
      "workspace_runtime_snapshot_invalid",
      "Workspace runtime returned an invalid message snapshot",
    )
  }
  const maxEventOrdinal = row.maxEventOrdinal
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
  return {
    messages: row.messages,
    maxEventOrdinal,
    session: row.session,
  }
}

function sessionPayloadId(input: unknown) {
  const row = rec(input)
  return txt(row?.id) ?? txt(row?.sessionId) ?? txt(row?.sessionID)
}

function assertPulledSession(input: unknown, sessionId: string) {
  if (sessionPayloadId(input) === sessionId) return
  throw new ControlPlaneProtocolError(
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
