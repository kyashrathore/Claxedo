import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { RuntimeConfigSnapshotPlugins, TurnDelivery, TurnExecutionAccess } from "@claxedo/harness/contract"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import { bearerToken, ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { privateSessionRuntimeProof, type PrivateSessionRuntimePrincipal, type SessionWriteClass } from "@claxedo/server-core/platform/auth/private-session-authority"
import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import { sessionHostAdmits, type SessionHostAuthority, type SessionHostPlacement } from "../authority/session-hosts"
import { resolveWorkspaceRuntimeTarget, WorkspaceRuntimeTargetError } from "../authority/runtime-target"
import { ownerDirectRows, PI_DIRECT_PROVIDERS } from "../credentials/direct-rows"
import { sessionLeasePrincipal } from "../session/runtime-session-proofs"
import type { RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

type TurnLeaseVerifier = NonNullable<RuntimeSessionAuthorityOptions["verifyTurnLease"]>
type TurnLeaseClaims = Awaited<ReturnType<TurnLeaseVerifier>>

export type SessionHostDeliveryOptions = {
  sessionHosts: SessionHostAuthority
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  credentials(orgId: string): ControlPlaneCredentials
  services: ControlPlaneServices
  plugins?(workspaceId: string): Promise<RuntimeConfigSnapshotPlugins>
  relayEndpoint(workspaceId: string, homeRegion: ClaxedoRegion): string | Promise<string>
  signRuntimeAccessToken: RuntimeAccessTokenSigner
}

const EXECUTION_TTL_SECONDS = 10 * 60
const UNAVAILABLE_RETRY_MS = 2_000
const requestSchema = z.object({ turnLease: z.string().min(1) }).strict()
const deleteSchema = z.object({ sessionId: z.string().min(1) }).strict()

/**
 * The calls a session's Durable Object makes of the control plane. Two per
 * turn, each proven by the turn lease the session authority issued it:
 * `/turn-delivery` hands it the provider accounts of the session's creator as
 * direct secrets, and `/turn-execution` mints it a session-scoped token for the
 * workspace's machine, where its tools run. Both answer only that session's own
 * host, only while its lease is the live one, and only while the turn's actor
 * may still send its turns. `/session-host-delete` deletes the session's row
 * for a request the host was relayed, as that request's actor, before the host
 * erases itself.
 */
export function SessionHostDeliveryRoutes(input: SessionHostDeliveryOptions & {
  authority: RuntimeSessionAuthorityOptions["authority"]
  verifyRelayProof: NonNullable<RuntimeSessionAuthorityOptions["verifyRelayProof"]>
  verifyTurnLease: TurnLeaseVerifier
  turnLeaseDenial(claims: TurnLeaseClaims): Promise<unknown>
}) {
  const denied = (c: Context) => c.json({ error: { code: "turn_delivery_denied" } }, 403)

  async function mayWrite(principal: PrivateSessionRuntimePrincipal, sessionId: string, workspaceId: string, writeClass: SessionWriteClass) {
    try {
      await input.authority.authorizeRuntimeSession({ ...principal, sessionId, workspaceId, action: "write", writeClass })
      return true
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return false
      throw error
    }
  }

  async function admittedTurn(c: Context): Promise<{ claims: TurnLeaseClaims; placement: SessionHostPlacement } | Response> {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: { code: "turn_delivery_request_invalid" } }, 400)
    let claims: TurnLeaseClaims
    try {
      claims = await input.verifyTurnLease(parsed.data.turnLease)
    } catch {
      return c.json({ error: { code: "session_turn_lease_invalid" } }, 401)
    }
    const host = claims.transport === "relay-host" || claims.transport === "deferred-grant" ? claims.hostId : undefined
    if (host !== sessionHostId(claims.sessionId) || await input.turnLeaseDenial(claims)) return denied(c)
    const { sessionId, workspaceId } = claims
    const placement = await input.sessionHosts.readSessionHostPlacement({ workspaceId, sessionId })
    if (!placement?.session || !sessionHostAdmits(placement, { workspaceId, sessionId })) return denied(c)
    const live = await input.sessionHosts.turnLeaseLive({ sessionId, turnId: claims.turnId, leaseId: claims.authorityLeaseId, fencingToken: claims.fencingToken })
    if (!live) return c.json({ error: { code: "session_turn_lease_invalid" } }, 401)
    if (!await mayWrite(sessionLeasePrincipal(claims), sessionId, workspaceId, "agent_turn")) return denied(c)
    return { claims, placement }
  }

  return new Hono()
    .post("/turn-delivery", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await admittedTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims, placement } = admitted
      const owner = await input.resolveWorkspaceOwner(claims.workspaceId)
      if (!owner || owner.orgId !== claims.orgId) return denied(c)
      const holder = placement.session!.creatorUserId ?? owner.userId
      const direct = await ownerDirectRows(input.credentials(owner.orgId), holder, { providers: PI_DIRECT_PROVIDERS })
      const delivery: TurnDelivery = {
        expiresAt: Math.min(claims.expiresAt, ...Object.values(direct).flatMap((row) => row.expiresAt === undefined ? [] : [row.expiresAt])),
        auth: { machineOwnerUserId: owner.userId, accounts: {}, direct: { [holder]: direct } },
        plugins: input.plugins ? await input.plugins(claims.workspaceId) : { harnessLaunch: {}, mcp: {} },
        providerDefinitions: [],
      }
      return c.json(delivery)
    })
    .post("/turn-execution", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await admittedTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims } = admitted
      const directory = admitted.placement.workspace.directory
      if (claims.principalKind !== "user" || !directory) return denied(c)
      let target: Awaited<ReturnType<typeof resolveWorkspaceRuntimeTarget>>
      try {
        target = await resolveWorkspaceRuntimeTarget(input.services, undefined, { workspaceId: claims.workspaceId, workspace: { backing: "cloud-vm" } })
      } catch (error) {
        if (!(error instanceof WorkspaceRuntimeTargetError) || error.status !== 409) throw error
        return c.json({ error: { code: "cloud_runtime_unavailable", retryAfterMs: error.retryAfterMs ?? UNAVAILABLE_RETRY_MS } }, 409)
      }
      const token = await input.signRuntimeAccessToken({
        principalKind: "user",
        actorId: claims.actorId,
        actorKind: "human",
        orgId: claims.orgId,
        workspaceId: claims.workspaceId,
        hostId: target.hostId,
        ...(target.routingId ? { routingId: target.routingId } : {}),
        role: "editor",
        sessionId: claims.sessionId,
        purpose: "turn-execution",
        ttlSeconds: EXECUTION_TTL_SECONDS,
      })
      await input.sessionHosts.recordTurnRuntimeAccessToken(claims.actorId, {
        jti: token.jti,
        workspaceId: claims.workspaceId,
        hostId: target.hostId,
        sessionId: claims.sessionId,
        expiresAt: token.tokenExpiresAt,
      })
      const relayUrl = await input.relayEndpoint(claims.workspaceId, target.homeRegion)
      const access: TurnExecutionAccess = {
        relayUrl: relayUrl.replace(/\/+$/, ""),
        workspaceId: claims.workspaceId,
        hostId: target.hostId,
        ...(target.routingId ? { routingId: target.routingId } : {}),
        runtimeAccessToken: token.runtimeAccessToken,
        expiresAt: token.tokenExpiresAt,
        directory,
      }
      return c.json(access)
    })
    .post("/session-host-delete", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      const refused = () => c.json({ error: { code: "session_host_delete_denied" } }, 403)
      const parsed = deleteSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ error: { code: "session_host_delete_request_invalid" } }, 400)
      const { sessionId } = parsed.data
      let proof: ReturnType<typeof privateSessionRuntimeProof>
      let scope: string | undefined
      try {
        const claims = await input.verifyRelayProof(bearerToken(c.req.header("authorization") ?? null) ?? "")
        proof = privateSessionRuntimeProof(claims)
        scope = claims.session_id
      } catch {
        return c.json({ error: { code: "relay_host_token_invalid" } }, 401)
      }
      const { workspaceId } = proof
      if (proof.hostId !== sessionHostId(sessionId) || (scope !== undefined && scope !== sessionId)) return refused()
      const active = asRecord(await input.authority.runtimeAccessTokenActive({ jti: proof.parentRuntimeAccessTokenJti, workspaceId, hostId: proof.hostId }))
      if (active?.active !== true) return refused()
      const placement = await input.sessionHosts.readSessionHostPlacement({ workspaceId, sessionId })
      if (!placement?.session || !sessionHostAdmits(placement, { workspaceId, sessionId })) return refused()
      if (!await mayWrite(sessionLeasePrincipal(proof), sessionId, workspaceId, "session_control")) return refused()
      return c.json({ deleted: await input.sessionHosts.deleteHostedSession({ workspaceId, sessionId }) })
    })
}
