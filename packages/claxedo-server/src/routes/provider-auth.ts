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
    .get("/provider/auth", (c) => c.json(service.methods()))
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
