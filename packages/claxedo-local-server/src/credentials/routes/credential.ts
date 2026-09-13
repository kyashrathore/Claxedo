/**
 * Credential management routes.
 *
 * Provides a dedicated API surface for listing, creating, and deleting
 * managed credentials. Used by the UI settings panels.
 */

import { Hono } from "hono"
import { z } from "zod"
import { defaultControlPlaneCredentials } from "@claxedo/server-core/authority/default-credentials"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { timingSafeEqualStrings } from "@claxedo/server-core/platform/auth/web-crypto"
import {
  checkCredential,
  credentialFailureDetail,
  type CredentialCheckOutcome,
} from "@claxedo/server-core/credentials/operations/check"
import { CredentialDiscoveryError } from "@claxedo/server-core/credentials/operations/discovery"
import { HARNESS_IDS } from "@claxedo/agent-runtime-contract"
import { machineLoginsWithUsage } from "@claxedo/server-core/credentials/machine-login-report"
import { credentialReach } from "@claxedo/server-core/credentials/native-delivery"
import type { MachineAgentUsageReader } from "@claxedo/server-core/credentials/machine-agent-usage"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
} from "@claxedo/server-core/platform/auth/auth"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "credential-routes" })

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
    kind: z.enum(["api_key", "oauth_token", "subscription_session", "sandbox_driver"]),
    scope: z.enum(["local", "shared"]),
  })),
})

const scopeBody = z.object({ scope: z.enum(["local", "shared"]) })

const reconnectBody = z.object({ secret: z.string().min(1) })

/**
 * Which account a harness runs on next: the rows that store one stored account,
 * or the explicit choice of no stored account at all, which is what leaves the
 * harness on the login its own CLI holds. Both are bounded because the caller
 * is naming a harness's bindings, of which there are a handful.
 */
const activateBody = z.union([
  z.object({ ids: z.array(z.string().min(1)).min(1).max(8) }).strict(),
  z.object({
    machine_login: z.object({ provider_ids: z.array(z.string().min(1)).min(1).max(8) }).strict(),
  }).strict(),
])

const machineLoginQuery = z.enum(HARNESS_IDS)

function redact(cred: Awaited<ReturnType<ControlPlaneCredentials["getCredentialByProvider"]>>) {
  if (!cred) return null
  return {
    id: cred.id,
    provider_id: cred.provider_id,
    kind: cred.kind,
    source: cred.source,
    label: cred.label,
    account_id: cred.account_id,
    owner: cred.owner ?? null,
    is_active: cred.is_active === true,
    status: cred.status,
    health: cred.health ?? null,
    has_secret: !!cred.secure_ref,
    expires_at: cred.expires_at,
    last_validated_at: cred.last_validated_at,
    scope: cred.scope ?? "local",
    // The surface says where the row came from; "desktop_discovery" is the only
    // record that a login was taken off this machine rather than typed in.
    consent: cred.consent ?? null,
    last_used_at: cred.last_used_at ?? null,
    last_error: cred.last_error,
    created_at: cred.created_at,
    updated_at: cred.updated_at,
    usage_windows: cred.usage_windows ?? null,
    usage_at: cred.usage_at ?? null,
    // Where this account can actually be spent, from the delivery rules
    // themselves. "Stored" is not the same fact: a ChatGPT subscription needs a
    // companion header no provider edge can attach, so it is local-only however
    // it was saved.
    deliverable: credentialReach(cred),
  }
}

function invalidBody(error: z.ZodError) {
  return errorBody("credential_invalid_body", "Invalid credential request body", error.flatten())
}

export type CredentialRoutesOptions = {
  /**
   * When set, every credential route requires `Authorization: Bearer <token>`.
   * Deployed/public instances must set this (CLAXEDO_CREDENTIALS_TOKEN) until
   * real accounts land: without it an unsigned public box would accept
   * anonymous credential writes/deletes and sync-local trigger.
   */
  token?: string
  fetch?: typeof fetch
  now?: () => number
  /**
   * The machine-wide plan probe, for the harnesses whose own CLI reports a
   * login and no figures. Absent leaves those rows saying what the harness
   * itself said, which is what a host that is not this machine can know.
   */
  agentUsage?: MachineAgentUsageReader
  authenticate?: (request: Request) => Promise<void>
  /**
   * Signed-auth configuration used to resolve the caller's org. When absent,
   * `requestOrg` passes no config and `controlPlaneAuthContext` applies its own
   * unsigned-local default — no environment is consulted here. That is what the
   * self-host composition relies on: signed auth off → the single-tenant
   * partition; signed auth on → the verified `org_id` claim from this config.
   */
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
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
  /**
   * One row, in the caller's org. Scoped before anything else runs: an
   * out-of-org id must 404 before a secret is resolved or a provider is called
   * on another org's key. A store with no id lookup answers from the list it
   * can scope.
   */
  const findCredential = async (id: string, scope: string) =>
    credentials.getCredential
      ? await credentials.getCredential(id, scope)
      : (await credentials.listCredentials(scope)).find((item) => item.id === id)
  const checkOptions = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  }
  /**
   * One Check, in the answer its caller can act on. A host that cannot verify,
   * a row whose secret is gone and a provider that refused the request are
   * three different repairs, so they are three different status codes rather
   * than one failure.
   */
  const checkAnswer = (id: string, outcome: CredentialCheckOutcome): readonly [unknown, 200 | 409 | 500 | 501 | 502] => {
    if (outcome.status === "unsupported") {
      return [errorBody("credential_verification_unavailable", "Credential verification is unavailable"), 501]
    }
    if (outcome.status === "no_secret") {
      return [errorBody("credential_secret_unavailable", "Credential secret is unavailable"), 409]
    }
    if (outcome.status === "failed") {
      log.warn("Credential verification failed", { credential_id: id, ...outcome.detail })
      return [
        errorBody("credential_verification_failed", "Credential verification failed", { detail: outcome.detail }),
        outcome.provider ? 502 : 500,
      ]
    }
    return [{
      result: outcome.health,
      health: outcome.health,
      verified_at: outcome.at,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    }, 200]
  }
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
      return undefined
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
      return undefined
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
    return undefined
  })
  return app
    .get("/", async (c) => {
      const creds = (await credentials.listCredentials(org(c.req.raw))).map(redact)
      return c.json({ credentials: creds })
    })
    .get("/effective", async (c) => {
      if (!credentials.effectiveCredentials) {
        return c.json(errorBody("credential_effective_unsupported", "This host does not report effective credentials"), 501)
      }
      const scope = c.req.query("scope") === "shared" ? "shared" : "local"
      const rows = await credentials.effectiveCredentials(scope, org(c.req.raw))
      return c.json({ scope, credentials: rows.map(redact) })
    })
    .get("/machine-logins", async (c) => {
      if (!credentials.machineLogins) {
        return c.json(errorBody("credential_machine_login_unavailable", "This host does not run the harnesses"), 501)
      }
      // Whoever is sitting at this machine, and nobody reached over a network:
      // this answers with the operator's own address and plan, and on the local
      // product the loopback socket is the only thing that identifies them.
      if (!isLoopbackLocalRequest(c.req.raw)) {
        return c.json(errorBody("loopback_required", "This computer's logins are readable from this computer only"), 403)
      }
      const asked = c.req.query("harness")
      const harness = asked === undefined ? undefined : machineLoginQuery.safeParse(asked)
      if (harness && !harness.success) return c.json(invalidBody(harness.error), 400)
      // A row's Check is the one caller that must not be answered from the last
      // read: it is the button a user presses to find out what changed.
      const fresh = c.req.query("fresh") === "1"
      try {
        return c.json({
          machine_logins: await machineLoginsWithUsage(credentials, {
            ...(harness ? { harnesses: [harness.data] } : {}),
            fresh,
            now: options.now ?? Date.now,
            ...(options.agentUsage ? { agentUsage: options.agentUsage } : {}),
          }),
        })
      } catch (error) {
        const detail = credentialFailureDetail(error)
        log.warn("Machine login read failed", detail)
        return c.json(errorBody("credential_machine_login_failed", "Failed to read this computer's logins", { detail }), 500)
      }
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
      } catch (error) {
        const detail = credentialFailureDetail(error)
        log.warn("Credential discovery failed", detail)
        return c.json(errorBody("credential_discovery_failed", "Failed to discover credentials", { detail }), 500)
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
      const credential = await findCredential(id, scope)
      if (!credential) {
        return c.json(errorBody("credential_not_found", "Credential not found"), 404)
      }
      const [body, status] = checkAnswer(id, await checkCredential(credentials, credential, { org: scope, ...checkOptions }))
      return c.json(body, status)
    })
    .post("/:id/reconnect", async (c) => {
      const body = reconnectBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      const id = c.req.param("id")
      const scope = org(c.req.raw)
      const credential = await findCredential(id, scope)
      if (!credential) {
        return c.json(errorBody("credential_not_found", "Credential not found"), 404)
      }
      if (!credentials.updateCredentialSecret || !credentials.updateCredentialHealth) {
        return c.json(errorBody("credential_reconnect_unavailable", "This host cannot replace stored credential material"), 501)
      }
      const outcome = await checkCredential(credentials, credential, {
        org: scope,
        secret: body.data.secret,
        replace: true,
        ...checkOptions,
      })
      const [answer, status] = checkAnswer(id, outcome)
      if (outcome.status === "checked" && outcome.stored === false) {
        log.warn("Reconnect rejected by the provider; the stored account is unchanged", {
          credential_id: id,
          health: outcome.health,
        })
      }
      return c.json(
        outcome.status === "checked" ? { ...(answer as object), stored: outcome.stored === true } : answer,
        status,
      )
    })
    .post("/activate", async (c) => {
      const body = activateBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      if ("machine_login" in body.data) {
        if (!credentials.clearActiveCredentials) {
          return c.json(errorBody("credential_activate_unsupported", "This host does not choose between accounts"), 501)
        }
        if (!isLoopbackLocalRequest(c.req.raw)) {
          return c.json(errorBody("loopback_required", "This computer's login is chosen from this computer only"), 403)
        }
        const cleared = await credentials.clearActiveCredentials(body.data.machine_login.provider_ids, org(c.req.raw))
        return c.json({ credentials: [], ...cleared })
      }
      if (!credentials.setActiveCredentials) {
        return c.json(errorBody("credential_activate_unsupported", "This host does not choose between accounts"), 501)
      }
      const result = await credentials.setActiveCredentials(body.data.ids, org(c.req.raw))
      if (!result.ok) {
        if (result.reason === "not_found") {
          return c.json(errorBody("credential_not_found", "Credential not found"), 404)
        }
        if (result.reason === "ambiguous") {
          return c.json(errorBody("credential_activate_ambiguous", "Two of these credentials compete for one provider"), 400)
        }
        return c.json(errorBody("credential_not_activatable", "This credential is not an account a harness runs on"), 409)
      }
      return c.json({ credentials: result.credentials.map(redact) })
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
