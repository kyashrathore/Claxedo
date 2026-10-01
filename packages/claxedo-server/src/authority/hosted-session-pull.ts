import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { SessionProjectionWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { ControlPlaneAuthContext } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import type { RelayRole } from "@claxedo/workspace-relay"
import type { ControlPlaneServices } from "./services"
import { resolveWorkspaceRuntimeTarget } from "./runtime-target"
import { WORKSPACE_RUNTIME_IDENTITY_PATH } from "@claxedo/server-core/platform/governance/route-ownership"
import { asRecord } from "@claxedo/helpers/guards"
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
} from "./pulled-session"
import { createRelayRuntimeClient } from "../workspace/relay-runtime-client"
import { txt } from "@claxedo/server-core/session/meta/shape"

export class HostedSessionPullError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function requireSignedAuth(auth: ControlPlaneAuthContext | undefined) {
  if (auth?.mode === "signed") return auth
  throw new HostedSessionPullError(401, "signed_auth_required", "Signed auth is required")
}

async function hostedWorkspaceForPull(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  workspaceId: string,
) {
  const signed = requireSignedAuth(auth)
  const opened = await requireAuthority(services).openWorkspace(signed, { workspaceId })
  const role = relayRole(opened.role)
  if (!role) throw new HostedSessionPullError(403, "workspace_authorization_denied", "Workspace access is denied")
  const ws = pulledCloudWorkspace(workspaceId, opened.workspace, HostedSessionPullError)
  return { workspaceId, ws, workspace: opened.workspace, role }
}

type RuntimePullInput = {
  workspaceId: string
  ws: ReturnType<typeof pulledCloudWorkspace>
  hostId: string
  routingId?: string
  homeRegion: ClaxedoRegion
  role: RelayRole
  path: string
}

async function runtimeJson(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: RuntimePullInput,
) {
  const provider = services.relay.provider
  if (!provider) {
    throw new HostedSessionPullError(503, "workspace_runtime_unavailable", "Workspace runtime pull transport is not configured")
  }
  const signed = requireSignedAuth(auth)
  return await createRelayRuntimeClient({
    provider, error: (status, code, message) => new HostedSessionPullError(status, code, message),
  }).json({
    workspaceId: input.workspaceId, hostId: input.hostId, routingId: input.routingId,
    homeRegion: input.homeRegion, principalKind: "user", auth: signed,
    ...await resolveRuntimeActor(requireAuthority(services), signed),
    orgId: input.ws.org_id, role: input.role, ttlMs: 10 * 60_000,
  }, input.path)
}

async function verifiedRuntimeJson(
  services: ControlPlaneServices,
  auth: ControlPlaneAuthContext | undefined,
  input: RuntimePullInput,
) {
  const health = asRecord(await runtimeJson(services, auth, {
    ...input,
    path: WORKSPACE_RUNTIME_IDENTITY_PATH,
  }))
  if (txt(health?.workspaceId) !== input.workspaceId) {
    throw new HostedSessionPullError(
      409,
      "workspace_runtime_mismatch",
      "Workspace runtime identity does not match requested workspace",
    )
  }
  return await runtimeJson(services, auth, input)
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
  const session = await verifiedRuntimeJson(services, signed, {
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
  const currentOrdinal = pullStartOrdinal(services.projectionStore, input.sessionId, input.expectedEventOrdinal)
  if (typeof currentOrdinal !== "number") return currentOrdinal
  const target = {
    ...workspace,
    ...await resolveWorkspaceRuntimeTarget(services, signed, workspace),
  }
  const pulled = await verifiedRuntimeJson(services, signed, {
    ...target,
    path: runtimePath(`/session/${encodeURIComponent(input.sessionId)}/message`, { snapshot: "1" }),
  })
  const payload = messagesPayload(pulled, HostedSessionPullError)
  const { updatedAt } = pulledSession(payload.session, input.sessionId, HostedSessionPullError)
  const syncAuthority = async (messages: unknown[], maxEventOrdinal: number, fencingToken?: number) => {
    const intakeReady = await runtimeJson(services, signed, {
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
      updatedAt,
      maxEventOrdinal,
      ...(fencingToken === undefined ? {} : { fencingToken }),
      intakeReady,
    })
  }
  const skipped = await projectPulledMessages({
    store: services.projectionStore,
    ws: target.ws,
    sessionId: input.sessionId,
    payload,
    currentOrdinal,
    refreshMetadata: () => syncHostedSessionMetadata(services, signed, target, input.sessionId, payload.session),
  })
  if (pullReachesAuthority(skipped)) {
    await syncAuthority(
      payload.messages,
      payload.maxEventOrdinal ?? services.projectionStore.read_session_max_event_ordinal(input.sessionId),
      payload.fencingToken,
    )
  }
  if (skipped) return skipped
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
  target: { workspaceId: string; ws: SessionProjectionWorkspace },
  sessionId: string,
  session: unknown,
) {
  const visibility = pulledSession(session, sessionId, HostedSessionPullError)
  await services.projectionStore.sync_session_meta(target.ws, session)
  await requireAuthority(services).upsertSessionVisibility(auth, {
    workspaceId: target.workspaceId,
    sessions: [visibility],
  })
}
