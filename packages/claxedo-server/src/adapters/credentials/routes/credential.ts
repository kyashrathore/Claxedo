/**
 * Credential management routes.
 *
 * Provides a dedicated API surface for listing, creating, and deleting
 * managed credentials. Used by the UI settings panels.
 */

import { Hono } from "hono"
import { z } from "zod"
import {
  defaultControlPlaneCredentials,
  type ControlPlaneCredentials,
} from "../../../authority/services"
import { errorBody } from "../../../platform/http/http"
import { timingSafeEqualStrings } from "../../../platform/auth/web-crypto"
import { CredentialVerificationError, verifyCredential } from "../operations/verify"
import { CredentialDiscoveryError } from "../operations/discovery"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
} from "../../../platform/auth/auth"
import { SINGLE_TENANT_ORG } from "../provider-credential.sql"

const putBody = z.object({
  provider_id: z.string().min(1),
  kind: z.enum(["api_key", "oauth_token", "subscription_session", "sandbox_driver"]),
  source: z.enum(["managed", "local_only", "env", "upstream_sync"]).default("managed"),
  label: z.string().optional(),
  account_id: z.string().optional(),
  secret: z.string().min(1),
  expires_at: z.number().optional(),
  scope: z.enum(["local", "shared"]).optional(),
})

const statusBody = z.object({
  status: z.enum(["available", "expired", "revoked", "error"]),
  error: z.string().optional(),
})

const syncBody = z.object({
  provider_ids: z.array(z.string().min(1)).optional(),
})

const saveDiscoveredBody = z.object({
  discovery_id: z.string().min(1),
  items: z.array(z.object({
    provider_id: z.string().min(1),
    account_id: z.string().min(1).optional(),
    scope: z.enum(["local", "shared"]),
  })),
})

const scopeBody = z.object({ scope: z.enum(["local", "shared"]) })

function redact(cred: Awaited<ReturnType<ControlPlaneCredentials["getCredentialByProvider"]>>) {
  if (!cred) return null
  return {
    id: cred.id,
    provider_id: cred.provider_id,
    kind: cred.kind,
    source: cred.source,
    label: cred.label,
    account_id: cred.account_id,
    status: cred.status,
    health: cred.health ?? null,
    has_secret: !!cred.secure_ref,
    expires_at: cred.expires_at,
    last_validated_at: cred.last_validated_at,
    scope: cred.scope ?? "local",
    last_used_at: cred.last_used_at ?? null,
    last_error: cred.last_error,
    created_at: cred.created_at,
    updated_at: cred.updated_at,
  }
}

function invalidBody(error: z.ZodError) {
  return errorBody("credential_invalid_body", "Invalid credential request body", error.flatten())
}

export type CredentialRoutesOptions = {
  /**
   * When set, EVERY credential route requires `Authorization: Bearer <token>`.
   * Deployed/public instances must set this (CLAXEDO_CREDENTIALS_TOKEN) until
   * real accounts land (W1): without it an unsigned public box would accept
   * anonymous credential writes/deletes and sync-local trigger.
   */
  token?: string
  fetch?: typeof fetch
  now?: () => number
  authenticate?: (request: Request) => Promise<void>
  /**
   * Signed-auth configuration used to resolve the CALLER'S ORG. Defaults to
   * `controlPlaneAuthConfig()` (process env), which is what the self-host
   * composition relies on: signed auth off → the single-tenant partition;
   * signed auth on → the verified `org_id` claim.
   */
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  /** Test/composition override for org resolution. */
  resolveOrg?: (request: Request) => Promise<string> | string
}

/**
 * The tenant every credential statement in this router runs as.
 *
 * Fail-closed by construction:
 *  - unsigned/local self-host → the NAMED single-tenant partition. Not a
 *    wildcard: it selects exactly the rows an install without organizations
 *    wrote, and nothing else.
 *  - signed with an `org_id` claim → that org.
 *  - signed WITHOUT an org claim (personal account) → the subject, so two
 *    org-less principals still cannot see each other's keys. This mirrors
 *    `runtimeTokenOrgId` (`auth.user.orgId ?? auth.user.subject`), the
 *    established convention for an absent org claim.
 *  - misconfigured signed auth → `controlPlaneAuthContext` throws 503, and an
 *    invalid/absent bearer throws 401. There is no path that resolves to
 *    "every org".
 *
 * Exported because it is the ONE tenant convention for credential-bearing
 * control-plane routes: `routes/provider-auth.ts` resolves its OAuth callback's
 * tenant through this same function rather than restating the rules, so the two
 * routers can never drift into disagreeing about who a request belongs to.
 */
export async function requestOrg(request: Request, options: CredentialRoutesOptions): Promise<string> {
  if (options.resolveOrg) {
    const resolved = await options.resolveOrg(request)
    return resolved?.trim() ? resolved.trim() : SINGLE_TENANT_ORG
  }
  const context: ControlPlaneAuthContext = await controlPlaneAuthContext(request, {
    ...(options.authConfig ? { config: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  if (context.mode !== "signed") return SINGLE_TENANT_ORG
  return context.user.orgId?.trim() || context.user.subject.trim() || SINGLE_TENANT_ORG
}

export function CredentialRoutes(
  credentials: ControlPlaneCredentials = defaultControlPlaneCredentials(),
  options: CredentialRoutesOptions = {},
) {
  const app = new Hono()
  // Resolved once per request; every handler reads it instead of re-deriving,
  // so no handler can accidentally run unscoped.
  const orgs = new WeakMap<Request, string>()
  const org = (request: Request) => orgs.get(request) ?? SINGLE_TENANT_ORG
  if (options.authenticate) {
    app.use(async (c, next) => {
      try {
        await options.authenticate!(c.req.raw)
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) {
          return c.json(controlPlaneAuthErrorBody(error), error.status)
        }
        throw error
      }
      await next()
    })
  }
  if (options.token) {
    const expected = `Bearer ${options.token}`
    app.use(async (c, next) => {
      // Constant-time: `!==` on a shared bearer secret short-circuits at the
      // first differing byte and leaks the matching prefix length. Every other
      // bearer comparison in the server already uses this helper
      // (internal-admin-auth, internal-relay, local-installation-broker); this
      // one guards the credential store — API keys, OAuth tokens, sandbox
      // driver secrets — so it is the last place to leave short-circuiting.
      if (!timingSafeEqualStrings(c.req.header("authorization") ?? "", expected)) {
        return c.json(errorBody("credential_unauthorized", "Missing or invalid credentials token"), 401)
      }
      await next()
    })
  }
  app.use(async (c, next) => {
    try {
      orgs.set(c.req.raw, await requestOrg(c.req.raw, options))
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status)
      }
      throw error
    }
    await next()
  })
  return app
    .get("/", async (c) => {
      const creds = (await credentials.listCredentials(org(c.req.raw))).map(redact)
      return c.json({ credentials: creds })
    })
    .get("/:providerId", async (c) => {
      const cred = await credentials.getCredentialByProvider(c.req.param("providerId"), undefined, org(c.req.raw))
      if (!cred) return c.json({ credential: null })
      return c.json({ credential: redact(cred) })
    })
    .put("/", async (c) => {
      const body = putBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        const cred = await credentials.putCredential({
          ...body.data,
          ...(body.data.scope === "shared" ? {
            consent: { at: (options.now ?? Date.now)(), surface: "api_key" as const },
          } : {}),
        }, org(c.req.raw))
        return c.json({ credential: redact(cred) })
      } catch {
        return c.json(errorBody("credential_store_failed", "Failed to store credential"), 500)
      }
    })
    .post("/discover", async (c) => {
      if (!credentials.discoverLocalCredentials) {
        return c.json(errorBody("credential_discovery_unavailable", "Credential discovery is unavailable"), 501)
      }
      try {
        return c.json(await credentials.discoverLocalCredentials(org(c.req.raw)))
      } catch {
        return c.json(errorBody("credential_discovery_failed", "Failed to discover credentials"), 500)
      }
    })
    .post("/save-discovered", async (c) => {
      const body = saveDiscoveredBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      if (!credentials.saveDiscoveredCredentials) {
        return c.json(errorBody("credential_discovery_unavailable", "Credential discovery is unavailable"), 501)
      }
      try {
        return c.json(await credentials.saveDiscoveredCredentials(body.data, org(c.req.raw)))
      } catch (error) {
        if (error instanceof CredentialDiscoveryError) {
          const status = error.code === "discovery_expired" ? 410 : error.code === "discovery_not_found" ? 404 : 400
          return c.json(errorBody(error.code, "The credential discovery can no longer be saved"), status)
        }
        return c.json(errorBody("credential_save_discovered_failed", "Failed to save discovered credentials"), 500)
      }
    })
    .post("/sync-local", async (c) => {
      const body = syncBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        const result = await credentials.syncLocalCredentials(body.data.provider_ids, org(c.req.raw))
        return c.json(result)
      } catch {
        return c.json(errorBody("credential_sync_failed", "Failed to sync local credentials"), 500)
      }
    })
    .post("/:id/verify", async (c) => {
      const id = c.req.param("id")
      const scope = org(c.req.raw)
      // Scoped lookup FIRST: an out-of-org id must 404 here, before the secret
      // is resolved or any provider round-trip is made on another org's key.
      const credential = credentials.getCredential
        ? await credentials.getCredential(id, scope)
        : (await credentials.listCredentials(scope)).find((item) => item.id === id)
      if (!credential) {
        return c.json(errorBody("credential_not_found", "Credential not found"), 404)
      }
      if (!credentials.resolveCredentialSecretById || !credentials.updateCredentialHealth) {
        return c.json(errorBody("credential_verification_unavailable", "Credential verification is unavailable"), 501)
      }
      const secret = await credentials.resolveCredentialSecretById(id, scope)
      if (!secret) {
        return c.json(errorBody("credential_secret_unavailable", "Credential secret is unavailable"), 409)
      }
      try {
        const { health, refreshed } = await verifyCredential(credential, secret, options)
        const verifiedAt = (options.now ?? Date.now)()
        // Persist first: a renewed access token that is verified but not stored
        // would make every later read fall back to the stale one.
        if (refreshed) {
          await credentials.updateCredentialSecret?.(id, refreshed.secret, refreshed.expiresAt, scope)
        }
        await credentials.updateCredentialHealth(id, health, verifiedAt, scope)
        return c.json({ result: health, health, verified_at: verifiedAt })
      } catch (error) {
        if (error instanceof CredentialVerificationError) {
          return c.json(errorBody("credential_verification_failed", "Credential verification failed"), 502)
        }
        return c.json(errorBody("credential_verification_failed", "Credential verification failed"), 500)
      }
    })
    .patch("/:id/status", async (c) => {
      const body = statusBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        await credentials.updateCredentialStatus(c.req.param("id"), body.data.status, body.data.error, org(c.req.raw))
        return c.json({ ok: true })
      } catch {
        return c.json(errorBody("credential_status_update_failed", "Failed to update credential status"), 500)
      }
    })
    .patch("/:id/scope", async (c) => {
      const body = scopeBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      if (!credentials.updateCredentialScope) {
        return c.json(errorBody("credential_scope_unavailable", "Credential scope updates are unavailable"), 501)
      }
      try {
        const updated = await credentials.updateCredentialScope(
          c.req.param("id"),
          body.data.scope,
          (options.now ?? Date.now)(),
          org(c.req.raw),
        )
        if (!updated) return c.json(errorBody("credential_not_found", "Credential not found"), 404)
        return c.json({ ok: true, scope: body.data.scope })
      } catch {
        return c.json(errorBody("credential_scope_update_failed", "Failed to update credential scope"), 500)
      }
    })
    .delete("/:id", async (c) => {
      const deleted = await credentials.deleteCredential(c.req.param("id"), org(c.req.raw))
      return c.json({ deleted })
    })
    .delete("/provider/:providerId", async (c) => {
      const count = await credentials.deleteCredentialsByProvider(
        c.req.param("providerId"),
        undefined,
        org(c.req.raw),
      )
      return c.json({ deleted: count })
    })
}
