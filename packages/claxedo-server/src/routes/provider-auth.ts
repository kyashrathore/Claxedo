import { Hono } from "hono"
import { z } from "zod"
import type { ControlPlaneServices } from "../authority/services"
import {
  createProviderAuthService,
  ProviderAuthError,
  type ProviderAuthService,
} from "../adapters/provider-auth/service"
import { controlPlaneRouteAuth, type ControlPlaneRouteAuthOptions } from "./control-plane-route-auth"
import { requestOrg } from "./credential"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "../authority/auth"
import { SINGLE_TENANT_ORG } from "../adapters/storage/provider-credential.sql"
import { errorBody } from "./http"

const authorizeBody = z.object({
  method: z.number().optional(),
  inputs: z.record(z.string(), z.string()).optional(),
})

const callbackBody = z.object({
  method: z.number().optional(),
  code: z.string().optional(),
})

type ProviderAuthRouteOptions = ControlPlaneRouteAuthOptions & {
  service?: ProviderAuthService
  /**
   * Test/composition override for tenant resolution, matching
   * `CredentialRoutesOptions.resolveOrg`. Left unset, the OAuth routes resolve
   * the caller's org through the credential router's `requestOrg` — the same
   * function, not a second copy of the rules.
   */
  resolveOrg?: (request: Request) => Promise<string> | string
  /**
   * Answered by a LATER-registered `/provider/auth` when this returns true.
   *
   * These routes are mounted before the OpenCode-compat ones, and Hono runs the
   * first registered match, so the compat handler for `/provider/auth` never
   * ran: an opencode workspace got the credential registry's ACP/codex methods
   * instead of the engine's provider catalog, and the connect dialog fell back
   * to "API Key" for every opencode provider because none of them appear in the
   * registry's fixed map. Deferring hands those requests to the compat route
   * without reordering the mounts, which would take every OTHER harness with it.
   */
  deferToHarnessRoute?: (harness: string | undefined) => Promise<boolean> | boolean
}

function invalidBody(error: z.ZodError) {
  return errorBody("provider_auth_invalid_body", "Invalid provider auth request body", error.flatten())
}

function authError(error: unknown) {
  if (error instanceof ProviderAuthError) return errorBody(error.code, error.message)
  return errorBody("provider_auth_failed", error instanceof Error ? error.message : String(error))
}


/**
 * Gated because a control-plane router with no per-route verification is open
 * the moment signed auth is enabled — and here there is more at stake than a
 * read surface. `route-ownership.ts` puts `/provider` in the AgentConfigRegistry domain next
 * to `/api/claxedo/agent-config` and `/api/claxedo/credentials`, both of which
 * are gated; this router was the one that was not. The OAuth callback below
 * calls `deleteCredentialsByProvider` + `putCredential`, so in signed mode an
 * unauthenticated caller could wipe a box's provider credentials and write its
 * own in their place — pointing the box's LLM traffic at an attacker-controlled
 * account. See `control-plane-route-auth.ts` for why the global guard does not
 * cover this posture.
 */
export function ProviderAuthRoutes(services: ControlPlaneServices, options: ProviderAuthRouteOptions = {}) {
  const service = options.service ?? createProviderAuthService(services.credentials)

  /**
   * The tenant each OAuth request runs as, resolved once and read by both
   * handlers so neither can run unscoped.
   *
   * The in-flight authorization the callback consumes lives in a server-side
   * map. Without a tenant in its key, org A could complete an authorization
   * org B had started and take delivery of its provider token; and the
   * callback's `deleteCredentialsByProvider` + `putCredential` pair ran against
   * the single-tenant partition for every caller. Resolution is the credential
   * router's own `requestOrg`, so an OAuth login lands in exactly the partition
   * the credential list reads back from.
   */
  const orgs = new WeakMap<Request, string>()
  const org = (request: Request) => orgs.get(request) ?? SINGLE_TENANT_ORG

  return new Hono()
    // Registered BEFORE the routes below, so it runs first for every
    // `/provider/*` request — including one the handler defers with `next()`.
    // The fall-through therefore reaches the compat route already authenticated
    // rather than around the gate. `provider-auth-defer-gate.test.ts` pins that.
    .use("/provider/*", controlPlaneRouteAuth(options))
    // Scoped to the OAuth paths only: `/provider/auth` may be deferred to the
    // harness compat route, which has no tenant of its own to resolve.
    .use("/provider/:providerId/oauth/*", async (c, next) => {
      try {
        orgs.set(c.req.raw, await requestOrg(c.req.raw, options))
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
        throw error
      }
      await next()
    })
    .get("/provider/auth", async (c, next) => {
      const harness = c.req.query("harness") ?? c.req.query("runner") ?? undefined
      if (await options.deferToHarnessRoute?.(harness)) return next()
      return c.json(service.methods())
    })
    .post("/provider/:providerId/oauth/authorize", async (c) => {
      const body = authorizeBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        return c.json(await service.authorize({
          providerId: c.req.param("providerId"),
          method: body.data.method,
          inputs: body.data.inputs,
          org: org(c.req.raw),
        }))
      } catch (error) {
        return c.json(authError(error), 400)
      }
    })
    .post("/provider/:providerId/oauth/callback", async (c) => {
      const body = callbackBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        return c.json(await service.callback({
          providerId: c.req.param("providerId"),
          method: body.data.method,
          code: body.data.code,
          org: org(c.req.raw),
        }))
      } catch (error) {
        return c.json(authError(error), 400)
      }
    })
}
