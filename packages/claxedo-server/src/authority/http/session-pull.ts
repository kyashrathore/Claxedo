import { resolveWorkspace, type SessionProjectionWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneAuthContext, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority, type WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import { CONTROL_PLANE_RUNTIME_ACTOR, resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { WORKSPACE_RUNTIME_IDENTITY_PATH } from "@claxedo/server-core/platform/governance/route-ownership"
import type { RelayRole } from "@claxedo/workspace-relay"
import { asRecord } from "@claxedo/helpers/guards"
import type { ControlPlaneServices } from "../services"
import { resolveWorkspaceRuntimeTarget } from "../runtime-target"
import { createRelayRuntimeClient, decodeRelayRuntimeJson, type RelayRuntimeCapability } from "../../workspace/relay-runtime-client"
import { ControlPlaneProtocolError, type ControlPlaneHttpOptions } from "./protocol"
import { txt } from "@claxedo/server-core/session/meta/shape"
import {
  messagesPayload,
  projectPulledMessages,
  pulledCloudWorkspace,
  pulledSession,
  pullReachesAuthority,
  pullStartOrdinal,
  relayRole,
  runtimePath,
  sessionIsIdle,
  workspaceRoleAllowsWrite,
} from "../pulled-session"

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
  const currentOrdinal = pullStartOrdinal(services.projectionStore, input.sessionId, input.expectedEventOrdinal)
  if (typeof currentOrdinal !== "number") return currentOrdinal
  const pulled = await verifiedRuntimeJson(services, options, {
    workspaceId: ws.id,
    ws,
    ...(scope.authorityWorkspace ? { authorityWorkspace: scope.authorityWorkspace } : {}),
    ...(scope.authorityRole ? { authorityRole: scope.authorityRole } : {}),
    auth,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}/message`, { snapshot: "1" }),
  })
  const payload = messagesPayload(pulled, ControlPlaneProtocolError)
  const { updatedAt } = pulledSession(payload.session, input.sessionId, ControlPlaneProtocolError)
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
      updatedAt,
      maxEventOrdinal: payload.maxEventOrdinal
        ?? services.projectionStore.read_session_max_event_ordinal(input.sessionId),
      ...(payload.fencingToken === undefined ? {} : { fencingToken: payload.fencingToken }),
      intakeReady,
    })
  }
  const skipped = await projectPulledMessages({
    store: services.projectionStore,
    ws,
    sessionId: input.sessionId,
    payload,
    currentOrdinal,
    refreshMetadata: () => syncPulledSessionMetadata(services, auth, ws, input.sessionId, payload.session),
  })
  if (pullReachesAuthority(skipped)) await syncAuthority()
  if (skipped) return skipped
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
  ws: SessionProjectionWorkspace,
  sessionId: string,
  session: unknown,
) {
  const visibility = pulledSession(session, sessionId, ControlPlaneProtocolError)
  await services.projectionStore.sync_session_meta(ws, session)
  if (auth?.mode !== "signed") return
  await requireAuthority(services).upsertSessionVisibility(auth, { workspaceId: ws.id, sessions: [visibility] })
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
  const ws = pulledCloudWorkspace(workspaceId, opened?.workspace, ControlPlaneProtocolError)
  return { ws, authorityWorkspace: opened?.workspace, authorityRole: relayRole(opened?.role) }
}

type SessionRuntimeInput = {
  workspaceId: string
  ws: Pick<Workspace, "org_id">
  authorityWorkspace?: WorkspaceRecord
  authorityRole?: RelayRole
  auth?: ControlPlaneAuthContext
  path: string
}

async function verifiedRuntimeJson(services: ControlPlaneServices, options: ControlPlaneHttpOptions, input: SessionRuntimeInput) {
  const health = asRecord(await runtimeJson(services, options, {
    ...input,
    path: WORKSPACE_RUNTIME_IDENTITY_PATH,
  }))
  if (txt(health?.workspaceId) !== input.workspaceId) {
    throw new ControlPlaneProtocolError(
      409,
      "workspace_runtime_mismatch",
      "Workspace runtime identity does not match requested workspace",
    )
  }
  return await runtimeJson(services, options, input)
}

async function runtimeJson(
  services: ControlPlaneServices,
  options: ControlPlaneHttpOptions,
  input: SessionRuntimeInput,
) {
  const error = (status: number, code: string, message: string) => new ControlPlaneProtocolError(status, code, message)
  if (options.runtimeFetch) {
    return await decodeRelayRuntimeJson(await options.runtimeFetch({ ...input, init: { headers: { accept: "application/json" } } }), error)
  }
  const capability = await sessionRuntimeCapability(services, input)
  const provider = services.relay.provider
  if (!provider) throw new ControlPlaneProtocolError(503, "workspace_runtime_unavailable", "Workspace runtime pull transport is not configured")
  return await createRelayRuntimeClient({ provider, error }).json(capability, input.path)
}

async function sessionRuntimeCapability(services: ControlPlaneServices, input: SessionRuntimeInput): Promise<RelayRuntimeCapability> {
  const target = await resolveWorkspaceRuntimeTarget(services, input.auth, {
    workspaceId: input.workspaceId,
    ...(input.authorityWorkspace ? { workspace: input.authorityWorkspace } : {}),
  })
  const orgId = input.ws.org_id
  if (!orgId) {
    throw new ControlPlaneProtocolError(
      409,
      "workspace_org_required",
      "Workspace is missing org identity for runtime token minting",
    )
  }
  if (input.auth?.mode === "signed" && !input.authorityRole) {
    throw new ControlPlaneProtocolError(
      403,
      "workspace_authorization_denied",
      "Workspace role is required for runtime token minting",
    )
  }
  return {
    workspaceId: input.workspaceId,
    hostId: target.hostId,
    routingId: target.routingId,
    ...(input.auth?.mode === "signed"
      ? { principalKind: "user" as const, auth: input.auth, ...await resolveRuntimeActor(requireAuthority(services), input.auth) }
      : CONTROL_PLANE_RUNTIME_ACTOR),
    orgId,
    role: input.auth?.mode === "signed" ? requiredRole(input.authorityRole) : "owner",
    ttlMs: 10 * 60_000,
    homeRegion: target.homeRegion,
  }
}

function requiredRole(role: RelayRole | undefined): RelayRole {
  if (role) return role
  throw new ControlPlaneProtocolError(403, "workspace_authorization_denied", "Workspace role is required for runtime token minting")
}
