import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { TurnDelivery, TurnExecutionAccess } from "@claxedo/harness/contract"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../authority/services"
import { sessionHostAdmits, type SessionHostAuthority } from "../authority/session-hosts"
import { resolveWorkspaceRuntimeTarget, WorkspaceRuntimeTargetError } from "../authority/runtime-target"
import { piDirectRows } from "../credentials/pi-direct-rows"
import type { RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

type TurnLeaseVerifier = NonNullable<RuntimeSessionAuthorityOptions["verifyTurnLease"]>
type TurnLeaseClaims = Awaited<ReturnType<TurnLeaseVerifier>>

export type SessionHostDeliveryOptions = {
  sessionHosts: SessionHostAuthority
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  credentials(orgId: string): ControlPlaneCredentials
  services: ControlPlaneServices
  relayEndpoint(workspaceId: string, homeRegion: ClaxedoRegion): string | Promise<string>
  signRuntimeAccessToken: RuntimeAccessTokenSigner
}

const EXECUTION_TTL_SECONDS = 10 * 60
const UNAVAILABLE_RETRY_MS = 2_000
const requestSchema = z.object({ turnLease: z.string().min(1) }).strict()

/**
 * The two calls a session's Durable Object makes per turn, each proven by the
 * turn lease the session authority issued it: `/turn-delivery` hands it the
 * session owner's provider accounts as direct secrets, and `/turn-execution`
 * mints it a session-scoped token for the workspace's machine, where its tools
 * run. Both answer only that session's own host, only while its lease is the
 * live one, and only while the turn's actor may still send its turns.
 */
export function SessionHostDeliveryRoutes(input: SessionHostDeliveryOptions & {
  authority: RuntimeSessionAuthorityOptions["authority"]
  verifyTurnLease: TurnLeaseVerifier
  turnLeaseDenial(claims: TurnLeaseClaims): Promise<unknown>
}) {
  const denied = (c: Context) => c.json({ error: { code: "turn_delivery_denied" } }, 403)

  async function admittedTurn(c: Context): Promise<{ claims: TurnLeaseClaims; directory: string | null } | Response> {
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
    const principal = claims.principalKind === "user"
      ? { principalKind: "user" as const, actorId: claims.actorId, actorKind: "human" as const }
      : { principalKind: "service" as const, actorId: claims.actorId, actorKind: "agent" as const }
    try {
      await input.authority.authorizeRuntimeSession({ ...principal, sessionId, workspaceId, action: "write" })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return denied(c)
      throw error
    }
    return { claims, directory: placement.workspace.directory }
  }

  return new Hono()
    .post("/turn-delivery", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await admittedTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims } = admitted
      const owner = await input.resolveWorkspaceOwner(claims.workspaceId)
      if (!owner || owner.orgId !== claims.orgId) return denied(c)
      const direct = await piDirectRows(input.credentials(owner.orgId), owner.userId)
      const delivery: TurnDelivery = {
        expiresAt: Math.min(claims.expiresAt, ...Object.values(direct).flatMap((row) => row.expiresAt === undefined ? [] : [row.expiresAt])),
        auth: { machineOwnerUserId: owner.userId, accounts: {}, direct: { [owner.userId]: direct } },
        plugins: { harnessLaunch: {}, mcp: {} },
        providerDefinitions: [],
      }
      return c.json(delivery)
    })
    .post("/turn-execution", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await admittedTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims, directory } = admitted
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
}
