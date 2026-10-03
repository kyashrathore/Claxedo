import { Hono } from "hono"
import { bearerToken } from "@claxedo/server-core/platform/auth/auth"
import { z } from "zod"
import type { ControlPlaneServices } from "../../authority/services"
import type { D1Database } from "@cloudflare/workers-types"
import { hostSessionCleanupOrigin } from "../../authority/adapters/d1/session-cleanup-origin"
import { sessionCleanupRuntimeRequest } from "../cleanup-runtime-client"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { machineSessionCleanupScope, resolveMachineCleanupOwner } from "../../authority/adapters/d1/session-cleanup-machine"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { createSessionCleanupRootGrant, isDesktopSessionCleanupScope, isMachineSessionCleanupScope, mintSessionCleanupCapability, resolveSessionCleanupOwner, SessionCleanupConfigurationError, verifySessionCleanupCapability, type SessionCleanupCapabilityInput } from "../cleanup-capability"

export function sessionCleanupGrantContribution(input: SessionCleanupCapabilityInput & { services?: ControlPlaneServices; database?: D1Database }): ControlPlaneRouteContribution {
  const mint = createSessionCleanupRootGrant(input)
  const routes = new Hono().post("/renew", async (c) => {
    const token = bearerToken(c.req.header("authorization"))
    if (!token) return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 401)
    let scope
    try {
      scope = await verifySessionCleanupCapability(token, input.signingEnv, {
        ...(input.passes ? { revoked: input.passes.revoked } : {}),
        ...(input.now ? { now: input.now } : {}),
      })
    } catch (cause) {
      if (cause instanceof SessionCleanupConfigurationError) return c.json({ error: { code: cause.code } }, 503)
      return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 401)
    }
    if (!(await resolveSessionCleanupOwner(input, scope))) return c.json({ error: { code: "session_cleanup_grant_withdrawn" } }, 403)
    const renewed = scope.sessionId || isMachineSessionCleanupScope(scope) || isDesktopSessionCleanupScope(scope) ? await mintSessionCleanupCapability(scope, input.signingEnv, input.passes ? { register: input.passes } : {}) : await mint(scope)
    return c.json({ token: renewed.token, expiresAt: renewed.expiresAt })
  })
  routes.post("/session", async (c) => {
    if (!input.services) return c.json({ error: { code: "session_cleanup_grant_unavailable" } }, 503)
    const body = z.strictObject({ sessionId: z.string().min(1), credential: z.string().min(1) }).safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) return c.json({ error: { code: "invalid_session_cleanup_origin" } }, 400)
    const token = bearerToken(c.req.header("authorization"))
    if (!token) return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 401)
    let root
    try {
      root = await verifySessionCleanupCapability(token, input.signingEnv, input.passes ? { revoked: input.passes.revoked } : {})
      if (root.sessionId || root.host || root.desktop || !(await resolveSessionCleanupOwner(input, root))) return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 403)
    } catch {
      return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 401)
    }
    const request = await sessionCleanupRuntimeRequest(input.services, root, root.workspaceId)
    const response = await request("/api/claxedo/session-cleanup/credential", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: body.data.credential }) })
    const proof = response.ok ? asRecord(await response.json().catch(() => undefined)) : undefined
    if (stringField(proof, "sessionId") !== body.data.sessionId || stringField(proof, "workspaceId") !== root.workspaceId || !stringField(proof, "runtimeId")) {
      return c.json({ error: { code: "session_cleanup_origin_invalid" } }, 403)
    }
    const scope = { ...root, sessionId: body.data.sessionId }
    const ancestors = new Set<string>()
    for (let sessionId: string | undefined = scope.sessionId; sessionId;) {
      if (ancestors.has(sessionId)) return c.json({ error: { code: "session_cleanup_origin_unreconciled" } }, 409)
      ancestors.add(sessionId)
      const infoResponse = await request(`/session/${encodeURIComponent(sessionId)}`)
      const info = infoResponse.ok ? asRecord(await infoResponse.json().catch(() => undefined)) : undefined
      const parentID = stringField(info, "parentID")
      if (stringField(info, "id") !== sessionId || !input.originParentMatches || !(await input.originParentMatches({ ...scope, sessionId }, parentID))) {
        return c.json({ error: { code: "session_cleanup_origin_unreconciled" } }, 409)
      }
      sessionId = parentID
    }
    if (!(await resolveSessionCleanupOwner(input, scope))) return c.json({ error: { code: "session_cleanup_origin_denied" } }, 403)
    const minted = await mintSessionCleanupCapability(scope, input.signingEnv, input.passes ? { register: input.passes } : {})
    return c.json({ token: minted.token, expiresAt: minted.expiresAt })
  })
  routes.post("/", async (c) => {
    const parsed = z.discriminatedUnion("scope", [
      z.strictObject({ scope: z.literal("session"), hostId: z.string().min(1), workspaceId: z.string().min(1), sessionId: z.string().min(1) }),
      z.strictObject({ scope: z.literal("machine"), hostId: z.string().min(1), orgId: z.string().min(1).optional() }),
    ])
      .safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: { code: "invalid_session_cleanup_grant_request" } }, 400)
    const verifier = input.services?.relay.hostTunnelTokenVerifier
    if (!verifier || !input.database) return c.json({ error: { code: "session_cleanup_grant_unavailable" } }, 503)
    const token = bearerToken(c.req.header("authorization"))
    if (!token) return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 401)
    const claims = await verifier(token, parsed.data.hostId).catch(() => undefined)
    if (!claims || claims.enrollment_id === undefined || claims.generation === undefined) return c.json({ error: { code: "session_cleanup_grant_invalid" } }, 401)
    const host = { hostId: claims.host_id, enrollmentId: claims.enrollment_id, generation: claims.generation }
    if (parsed.data.scope === "machine") {
      const owner = await resolveMachineCleanupOwner(input.database, host, claims.sub, parsed.data.orgId)
      if (!owner) return c.json({ error: { code: "session_cleanup_machine_scope_unavailable", message: "Select a single active organization for this enrolled machine" } }, 403)
      const scope = machineSessionCleanupScope(owner, host)
      if (!(await resolveSessionCleanupOwner(input, scope))) return c.json({ error: { code: "session_cleanup_account_consent_required", message: "Enable Session cleanup for all projects in this organization" } }, 403)
      const minted = await mintSessionCleanupCapability(scope, input.signingEnv, input.passes ? { register: input.passes } : {})
      return c.json({ token: minted.token, expiresAt: minted.expiresAt })
    }
    const { workspaceId, sessionId } = parsed.data
    const publisher = { hostId: claims.host_id, ownerUserId: claims.sub, workspaceIds: claims.workspace_ids, enrollmentId: claims.enrollment_id, generation: claims.generation }
    const owner = await input.workspaceOwner(workspaceId)
    if (!owner || owner.userId !== claims.sub || !(await hostSessionCleanupOrigin(input.database, publisher, workspaceId, sessionId))) {
      return c.json({ error: { code: "session_cleanup_grant_access_denied" } }, 403)
    }
    const scope = { ...owner, workspaceId, sessionId, host: { hostId: claims.host_id, enrollmentId: claims.enrollment_id, generation: claims.generation } }
    if (!(await resolveSessionCleanupOwner(input, scope))) return c.json({ error: { code: "session_cleanup_grant_withdrawn" } }, 403)
    const minted = await mintSessionCleanupCapability(scope, input.signingEnv, input.passes ? { register: input.passes } : {})
    return c.json({ token: minted.token, expiresAt: minted.expiresAt })
  })
  return { id: "session-cleanup-grant", path: "/api/claxedo/session-cleanup/grant", routes }
}
