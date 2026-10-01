import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { decodeJwt } from "jose"
import { z } from "zod"
import { asRecord } from "@claxedo/helpers/guards"
import { bearerToken } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { HarnessConnectionDescriptor } from "@claxedo/server-core/agent-config/connections"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { credentialSecretInScope } from "@claxedo/server-core/credentials/secret-scope"
import { credentialAdmitted } from "@claxedo/server-core/credentials/account-holder"
import type { ControlPlaneCredentials } from "../authority/services"
import type { RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

export type RuntimeConnectionSecretOptions = {
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  readConnections(userId: string): Promise<Record<string, HarnessConnectionDescriptor>>
  credentials(orgId: string): ControlPlaneCredentials
}

const requestSchema = z.object({
  connectionId: z.string().min(1),
  providerKey: z.string().min(1),
  configRevision: z.number().int().positive(),
  ownerUserId: z.string().min(1),
  turnLease: z.string().min(1).optional(),
}).strict()

type LeaseAuthority = { orgId: string; workspaceId: string; expiresAt: number }
type TurnLeaseVerifier = NonNullable<RuntimeSessionAuthorityOptions["verifyTurnLease"]>

const MAX_LEASE_MS = 60_000

export function RuntimeConnectionSecretRoutes(input: RuntimeConnectionSecretOptions & {
  authority: RuntimeSessionAuthorityOptions["authority"]
  verifyRelayProof: NonNullable<RuntimeSessionAuthorityOptions["verifyRelayProof"]>
  verifyTurnLease: TurnLeaseVerifier
  /** The session authority's own recheck of the chain behind a turn lease. */
  turnLeaseDenial(claims: Awaited<ReturnType<TurnLeaseVerifier>>): Promise<unknown>
}) {
  const denied = (c: Context) => c.json({ error: { code: "connection_secret_denied" } }, 403)

  /** A request proves itself with its relay proof: the owner's workspace-wide one, from a cloud sandbox, whose parent token is still active. */
  async function relayAuthority(c: Context, token: string): Promise<LeaseAuthority | Response> {
    let proof: Awaited<ReturnType<typeof input.verifyRelayProof>>
    let expiresAt: number
    try {
      proof = await input.verifyRelayProof(token)
      const claims = decodeJwt(token)
      if (typeof claims.exp !== "number" || claims.backing !== "cloud-vm") throw new Error("Invalid sandbox proof")
      expiresAt = claims.exp * 1000
    } catch {
      return c.json({ error: { code: "relay_host_token_invalid" } }, 401)
    }
    if (proof.session_id !== undefined) return denied(c)
    const active = asRecord(await input.authority.runtimeAccessTokenActive({
      jti: proof.parent_jti, workspaceId: proof.workspace_id, hostId: proof.host_id,
    }))
    if (active?.active !== true) return denied(c)
    return { orgId: proof.org_id, workspaceId: proof.workspace_id, expiresAt }
  }

  /** A turn proves itself with the lease its admission was issued, however long ago the request that queued it ended. */
  async function turnAuthority(c: Context, lease: string): Promise<LeaseAuthority | Response> {
    let claims: Awaited<ReturnType<TurnLeaseVerifier>>
    try {
      claims = await input.verifyTurnLease(lease)
    } catch {
      return c.json({ error: { code: "session_turn_lease_invalid" } }, 401)
    }
    if (await input.turnLeaseDenial(claims)) return denied(c)
    return { orgId: claims.orgId, workspaceId: claims.workspaceId, expiresAt: claims.expiresAt }
  }

  return new Hono().post("/:workspaceId", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    c.header("cache-control", "no-store")
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: { code: "connection_secret_request_invalid" } }, 400) }
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: { code: "connection_secret_request_invalid" } }, 400)
    const request = parsed.data
    const bearer = bearerToken(c.req.header("authorization") ?? null)
    if (!!bearer === !!request.turnLease) return c.json({ error: { code: "connection_secret_proof_required" } }, 401)
    const authority = request.turnLease ? await turnAuthority(c, request.turnLease) : await relayAuthority(c, bearer!)
    if (authority instanceof Response) return authority
    const workspaceId = c.req.param("workspaceId")
    if (authority.workspaceId !== workspaceId) return denied(c)
    let expiresAt = Math.min(authority.expiresAt, Date.now() + MAX_LEASE_MS)
    if (expiresAt <= Date.now()) return c.json({ error: { code: "connection_secret_proof_expired" } }, 401)
    const workspaceOwner = await input.resolveWorkspaceOwner(workspaceId)
    if (!workspaceOwner || workspaceOwner.orgId !== authority.orgId) return denied(c)
    const descriptor = (await input.readConnections(workspaceOwner.userId))[request.connectionId]
    const unavailable = () => c.json({ error: { code: "connection_unavailable" } }, 409)
    if (request.ownerUserId !== workspaceOwner.userId) return unavailable()
    if (!descriptor?.enabled || descriptor.configRevision !== request.configRevision || descriptor.providerKey !== request.providerKey) return unavailable()
    const signature = JSON.stringify(descriptor)
    const credentials = input.credentials(workspaceOwner.orgId)
    if (!credentials.getCredential || !credentials.resolveCredentialSecretById) {
      return c.json({ error: { code: "connection_secret_store_unavailable" } }, 503)
    }
    const permitted = (meta: CredentialMetadata | undefined): meta is CredentialMetadata => !!meta
      && meta.status === "available"
      && credentialSecretInScope(meta, "shared")
      && meta.org_id === workspaceOwner.orgId
      && credentialAdmitted(meta.owner, request.ownerUserId, workspaceOwner.userId)
      && (meta.expires_at == null || meta.expires_at > Date.now())
    const sameStoredSecret = (a: CredentialMetadata, b: Pick<CredentialMetadata, "incarnation" | "revision">) =>
      a.incarnation === b.incarnation && a.revision === b.revision
    const secrets: Record<string, string> = {}
    const generations: Array<[string, string, string, number]> = []
    for (const [name, reference] of Object.entries(descriptor.secretRefs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const meta = await credentials.getCredential(reference, workspaceOwner.orgId)
      if (!permitted(meta)) return unavailable()
      const secret = await credentials.resolveCredentialSecretById(reference, workspaceOwner.orgId)
      const current = await credentials.getCredential(reference, workspaceOwner.orgId)
      if (!secret || !permitted(current) || !sameStoredSecret(current, meta)) return unavailable()
      if (current.expires_at != null) expiresAt = Math.min(expiresAt, current.expires_at)
      secrets[name] = secret
      generations.push([name, reference, current.incarnation, current.revision])
    }
    for (const [, reference, incarnation, revision] of generations) {
      const current = await credentials.getCredential(reference, workspaceOwner.orgId)
      if (!permitted(current) || !sameStoredSecret(current, { incarnation, revision })) return unavailable()
      if (current.expires_at != null) expiresAt = Math.min(expiresAt, current.expires_at)
    }
    if (JSON.stringify((await input.readConnections(workspaceOwner.userId))[request.connectionId]) !== signature || expiresAt <= Date.now()) return unavailable()
    return c.json({ secrets, secretLeaseGeneration: JSON.stringify([request.connectionId, request.configRevision, generations]), expiresAt })
  })
}
