import { Hono } from "hono"
import { z } from "zod"
import type { ControlPlaneServices } from "../control-plane/services"
import {
  createProviderAuthService,
  ProviderAuthError,
  type ProviderAuthService,
} from "../provider-auth/service"
import { errorBody } from "./http"

const authorizeBody = z.object({
  method: z.number().optional(),
  inputs: z.record(z.string(), z.string()).optional(),
})

const callbackBody = z.object({
  method: z.number().optional(),
  code: z.string().optional(),
})

type ProviderAuthRouteOptions = {
  service?: ProviderAuthService
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

export function ProviderAuthRoutes(services: ControlPlaneServices, options: ProviderAuthRouteOptions = {}) {
  const service = options.service ?? createProviderAuthService(services.credentials)

  return new Hono()
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
        }))
      } catch (error) {
        return c.json(authError(error), 400)
      }
    })
}
