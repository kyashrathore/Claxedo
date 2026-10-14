import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { RuntimeConfigSnapshotPlugins, TurnDelivery, TurnExecutionAccess } from "@claxedo/harness/contract"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import { bearerToken, ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { privateSessionRuntimeProof, type PrivateSessionRuntimePrincipal, type SessionWriteClass } from "@claxedo/server-core/platform/auth/private-session-authority"
import { asRecord } from "@claxedo/helpers/guards"
import type { ControlPlaneCredentials } from "../authority/services"
import { sessionHostAdmits, type SessionHostPlacement } from "../authority/session-hosts"
import type { SessionMcpCredentials } from "../mcp/session-mcp-credentials"
import { WorkspaceRuntimeTargetError } from "../authority/runtime-target"
import { sessionHostMachineAccess, type SessionHostMachineDeps } from "../authority/session-host-machine-access"
import { createCredentialRefusals, type CredentialRefusals } from "../credentials/credential-refusals"
import { ownerDirectRows, PI_DIRECT_PROVIDERS } from "../credentials/direct-rows"
import { sessionLeasePrincipal } from "../session/runtime-session-proofs"
import type { RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

type TurnLeaseVerifier = NonNullable<RuntimeSessionAuthorityOptions["verifyTurnLease"]>
type TurnLeaseClaims = Awaited<ReturnType<TurnLeaseVerifier>>

export type SessionHostDeliveryOptions = SessionHostMachineDeps & {
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  credentials(orgId: string): ControlPlaneCredentials
  plugins?(workspaceId: string): Promise<RuntimeConfigSnapshotPlugins>
  sessionMcp?: Pick<SessionMcpCredentials, "issue">
  /** The plane's one rule for a vendor refusing a stored account; the broker's by default. */
  credentialRefusals?: CredentialRefusals
}

const EXECUTION_TTL_SECONDS = 10 * 60
const UNAVAILABLE_RETRY_MS = 2_000
const requestSchema = z.object({ turnLease: z.string().min(1) }).strict()
const refusedSchema = z.object({ turnLease: z.string().min(1), credentialId: z.string().min(1) }).strict()
const deleteSchema = z.object({ sessionId: z.string().min(1) }).strict()

/**
 * The calls a session's Durable Object makes of the control plane, each
 * proven by the turn lease the session authority issued it: `/turn-delivery`
 * hands it the provider accounts of the session's creator as direct secrets
 * and, for a turn the workspace owner drives in their own session, the
 * first-party MCP server with that turn's bearer; `/turn-execution` mints it
 * a session-scoped token for the workspace's machine, where its tools run.
 * Both answer only that session's own host, only while its lease is the live
 * one, and only while the turn's actor may still send its turns.
 * `/turn-credential-refused` takes the host's word that the vendor refused
 * one of the accounts it was handed, under the same rule the plane's broker
 * applies to its own refusals; the lease may be released by then, since the
 * turn ends on the refusal. `/session-host-delete` deletes the session's row
 * for a request the host was relayed, as that request's actor, before the
 * host erases itself.
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

  async function admittedTurn(c: Context, turnLease: string, options: { live: boolean }): Promise<{ claims: TurnLeaseClaims; placement: SessionHostPlacement } | Response> {
    let claims: TurnLeaseClaims
    try {
      claims = await input.verifyTurnLease(turnLease)
    } catch {
      return c.json({ error: { code: "session_turn_lease_invalid" } }, 401)
    }
    const host = claims.transport === "relay-host" || claims.transport === "deferred-grant" ? claims.hostId : undefined
    if (host !== sessionHostId(claims.sessionId) || await input.turnLeaseDenial(claims)) return denied(c)
    const { sessionId, workspaceId } = claims
    const placement = await input.sessionHosts.readSessionHostPlacement({ workspaceId, sessionId })
    if (!placement?.session || !sessionHostAdmits(placement, { workspaceId, sessionId })) return denied(c)
    if (options.live) {
      const live = await input.sessionHosts.turnLeaseLive({ sessionId, turnId: claims.turnId, leaseId: claims.authorityLeaseId, fencingToken: claims.fencingToken })
      if (!live) return c.json({ error: { code: "session_turn_lease_invalid" } }, 401)
    }
    if (!await mayWrite(sessionLeasePrincipal(claims), sessionId, workspaceId, "agent_turn")) return denied(c)
    return { claims, placement }
  }

  async function liveTurn(c: Context) {
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: { code: "turn_delivery_request_invalid" } }, 400)
    return admittedTurn(c, parsed.data.turnLease, { live: true })
  }

  const refusals = input.credentialRefusals ?? createCredentialRefusals({ credentials: input.credentials })

  return new Hono()
    .onError((error, c) => {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      console.error(`[session-host-delivery] ${c.req.path} failed:`, error.stack ?? error.message)
      return c.json({ error: { code: "session_host_authority_failed" } }, 500)
    })
    .post("/turn-delivery", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await liveTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims, placement } = admitted
      const owner = await input.resolveWorkspaceOwner(claims.workspaceId)
      if (!owner || owner.orgId !== claims.orgId) return denied(c)
      const holder = placement.session!.creatorUserId ?? owner.userId
      const direct = await ownerDirectRows(input.credentials(owner.orgId), holder, { providers: PI_DIRECT_PROVIDERS })
      let plugins: RuntimeConfigSnapshotPlugins = { harnessLaunch: {}, mcp: {} }
      try {
        if (input.plugins) plugins = await input.plugins(claims.workspaceId)
      } catch (error) {
        console.error(`[session-host-delivery] the plugins of ${claims.workspaceId} were not applied:`, error instanceof Error ? error.message : String(error))
        return c.json({ error: { code: "agent_plugins_unavailable" } }, 502)
      }
      const expiresAt = Math.min(claims.expiresAt, ...Object.values(direct).flatMap((row) => row.expiresAt === undefined ? [] : [row.expiresAt]))
      const firstPartyMcp = holder === owner.userId && claims.actorId === owner.actorId
        ? await input.sessionMcp?.issue({ origin: new URL(c.req.url).origin, owner, workspaceId: claims.workspaceId, sessionId: claims.sessionId, expiresAt })
        : undefined
      const delivery: TurnDelivery = {
        expiresAt,
        auth: { machineOwnerUserId: owner.userId, accounts: {}, direct: { [holder]: direct } },
        plugins,
        providerDefinitions: [],
        ...(firstPartyMcp ? { firstPartyMcp } : {}),
      }
      return c.json(delivery)
    })
    .post("/turn-execution", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await liveTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims } = admitted
      const directory = admitted.placement.workspace.directory
      if (claims.principalKind !== "user" || !directory) return denied(c)
      let machine: Awaited<ReturnType<typeof sessionHostMachineAccess>>
      try {
        machine = await sessionHostMachineAccess(input, {
          scope: "turn", actorId: claims.actorId, orgId: claims.orgId, workspaceId: claims.workspaceId, sessionId: claims.sessionId, ttlSeconds: EXECUTION_TTL_SECONDS,
        })
      } catch (error) {
        if (!(error instanceof WorkspaceRuntimeTargetError) || error.status !== 409) throw error
        return c.json({ error: { code: "cloud_runtime_unavailable", retryAfterMs: error.retryAfterMs ?? UNAVAILABLE_RETRY_MS } }, 409)
      }
      const access: TurnExecutionAccess = { ...machine, workspaceId: claims.workspaceId, directory }
      return c.json(access)
    })
    .post("/turn-credential-refused", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      const parsed = refusedSchema.safeParse(await c.req.json().catch(() => undefined))
      if (!parsed.success) return c.json({ error: { code: "turn_delivery_request_invalid" } }, 400)
      const admitted = await admittedTurn(c, parsed.data.turnLease, { live: false })
      if (admitted instanceof Response) return admitted
      const { claims, placement } = admitted
      const owner = await input.resolveWorkspaceOwner(claims.workspaceId)
      if (!owner || owner.orgId !== claims.orgId) return denied(c)
      const holder = placement.session!.creatorUserId ?? owner.userId
      const credential = await input.credentials(owner.orgId).getCredential?.(parsed.data.credentialId)
      if (!credential || credential.owner !== holder || !PI_DIRECT_PROVIDERS.has(credential.provider_id)) return denied(c)
      return c.json({ refusal: await refusals.refused(owner.orgId, credential, credential.revision) })
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
