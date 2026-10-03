import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { RuntimeConfigSnapshotPlugins, TurnDelivery, TurnExecutionAccess } from "@claxedo/harness/contract"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import { directProviderDeliveriesFromRepository } from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials } from "../authority/services"
import type { SessionHostAuthority } from "../authority/session-hosts"
import type { RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

type TurnLeaseVerifier = NonNullable<RuntimeSessionAuthorityOptions["verifyTurnLease"]>
type TurnLeaseClaims = Awaited<ReturnType<TurnLeaseVerifier>>

export type SessionHostDeliveryOptions = {
  sessionHosts: SessionHostAuthority
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  credentials(orgId: string): ControlPlaneCredentials
  /** The owner's plugin MCP and launch rows for Pi; absent, a session host runs without plugins. */
  plugins?(input: { workspaceId: string; ownerUserId: string }): Promise<RuntimeConfigSnapshotPlugins>
  sandboxManager?: Pick<SandboxManager, "target">
  relayEndpoint(workspaceId: string, homeRegion: ClaxedoRegion): string | Promise<string>
  signRuntimeAccessToken: RuntimeAccessTokenSigner
}

const PI_STORED_PROVIDERS: ReadonlySet<string> = new Set(PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs))
const EXECUTION_TTL_SECONDS = 10 * 60
const UNAVAILABLE_RETRY_MS = 2_000
const requestSchema = z.object({ turnLease: z.string().min(1) }).strict()

/**
 * The two calls a session's Durable Object makes per turn, each proven by the
 * turn lease the session authority issued it: `/turn-delivery` hands it the
 * session owner's provider accounts as direct secrets plus the owner's plugin
 * rows, and `/turn-execution` mints it a session-scoped token for the
 * workspace's machine, where its tools run. Both answer only for a session the
 * control plane recorded as served by its own host, and only while the turn's
 * actor may still send its turns.
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
    if (await input.turnLeaseDenial(claims)) return denied(c)
    const placement = await input.sessionHosts.readSessionHostPlacement({ workspaceId: claims.workspaceId, sessionId: claims.sessionId })
    if (placement?.session?.workspaceId !== claims.workspaceId || placement.session.sessionHostRoot !== claims.sessionId) return denied(c)
    const principal = claims.principalKind === "user"
      ? { principalKind: "user" as const, actorId: claims.actorId, actorKind: "human" as const }
      : { principalKind: "service" as const, actorId: claims.actorId, actorKind: "agent" as const }
    try {
      await input.authority.authorizeRuntimeSession({ ...principal, sessionId: claims.sessionId, workspaceId: claims.workspaceId, action: "write" })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return denied(c)
      throw error
    }
    return { claims, directory: placement.workspace.directory }
  }

  async function ownerDirectRows(owner: WorkspaceOwnerIdentity) {
    const credentials = input.credentials(owner.orgId)
    const selected = (await credentials.listCredentials())
      .filter((credential) => PI_STORED_PROVIDERS.has(credential.provider_id) && !!builtInProviderRow(credential.provider_id)
        && (credential.kind === "api_key" || credential.kind === "oauth_token"))
      .map((credential) => ({ credential, ...(credential.status !== "available" ? { unavailable: credential.status } : {}) }))
    return await directProviderDeliveriesFromRepository({
      owner: owner.userId,
      machineOwnerUserId: owner.userId,
      selections: await credentials.accountSelections(),
      selected,
      readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
    })
  }

  return new Hono()
    .post("/turn-delivery", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await admittedTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims } = admitted
      const owner = await input.resolveWorkspaceOwner(claims.workspaceId)
      if (!owner || owner.orgId !== claims.orgId) return denied(c)
      const rows = await ownerDirectRows(owner)
      if (rows.some((row) => row.unavailable === "unreadable_secret")) return c.json({ error: { code: "account_unavailable" } }, 409)
      const direct: Record<string, ProviderDirect> = {}
      let expiresAt = claims.expiresAt
      for (const row of rows) {
        if (!row.direct) continue
        direct[row.providerId] = row.direct
        if (row.direct.expiresAt !== undefined) expiresAt = Math.min(expiresAt, row.direct.expiresAt)
      }
      const delivery: TurnDelivery = {
        expiresAt,
        auth: { machineOwnerUserId: owner.userId, accounts: {}, direct: { [owner.userId]: direct } },
        plugins: input.plugins ? await input.plugins({ workspaceId: claims.workspaceId, ownerUserId: owner.userId }) : { harnessLaunch: {}, mcp: {} },
        providerDefinitions: [],
      }
      return c.json(delivery)
    })
    .post("/turn-execution", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
      c.header("cache-control", "no-store")
      const admitted = await admittedTurn(c)
      if (admitted instanceof Response) return admitted
      const { claims, directory } = admitted
      if (claims.principalKind !== "user") return denied(c)
      const target = await input.sandboxManager?.target(claims.workspaceId)
      if (target?.status !== "ready" || !directory) {
        const retryAfterMs = target?.status === "unavailable" ? target.retryAfterMs ?? UNAVAILABLE_RETRY_MS : UNAVAILABLE_RETRY_MS
        return c.json({ error: { code: "cloud_runtime_unavailable", retryAfterMs } }, 409)
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
      const access: TurnExecutionAccess = {
        relayUrl: (await input.relayEndpoint(claims.workspaceId, target.homeRegion)).replace(/\/+$/, ""),
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
