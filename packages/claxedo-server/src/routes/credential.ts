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
} from "../control-plane/services"
import { errorBody } from "./http"

const putBody = z.object({
  provider_id: z.string().min(1),
  kind: z.enum(["api_key", "oauth_token", "subscription_session", "sandbox_driver"]),
  source: z.enum(["managed", "local_only", "env", "upstream_sync"]).default("managed"),
  label: z.string().optional(),
  account_id: z.string().optional(),
  secret: z.string().min(1),
  expires_at: z.number().optional(),
})

const statusBody = z.object({
  status: z.enum(["available", "expired", "revoked", "error"]),
  error: z.string().optional(),
})

const syncBody = z.object({
  provider_ids: z.array(z.string().min(1)).optional(),
})

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
    has_secret: !!cred.secure_ref,
    expires_at: cred.expires_at,
    last_validated_at: cred.last_validated_at,
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
}

export function CredentialRoutes(
  credentials: ControlPlaneCredentials = defaultControlPlaneCredentials(),
  options: CredentialRoutesOptions = {},
) {
  const app = new Hono()
  if (options.token) {
    const expected = `Bearer ${options.token}`
    app.use(async (c, next) => {
      if (c.req.header("authorization") !== expected) {
        return c.json(errorBody("credential_unauthorized", "Missing or invalid credentials token"), 401)
      }
      await next()
    })
  }
  return app
    .get("/", async (c) => {
      const creds = (await credentials.listCredentials()).map(redact)
      return c.json({ credentials: creds })
    })
    .get("/:providerId", async (c) => {
      const cred = await credentials.getCredentialByProvider(c.req.param("providerId"))
      if (!cred) return c.json({ credential: null })
      return c.json({ credential: redact(cred) })
    })
    .put("/", async (c) => {
      const body = putBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        const cred = await credentials.putCredential(body.data)
        return c.json({ credential: redact(cred) })
      } catch {
        return c.json(errorBody("credential_store_failed", "Failed to store credential"), 500)
      }
    })
    .post("/sync-local", async (c) => {
      const body = syncBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        const result = await credentials.syncLocalCredentials(body.data.provider_ids)
        return c.json(result)
      } catch {
        return c.json(errorBody("credential_sync_failed", "Failed to sync local credentials"), 500)
      }
    })
    .patch("/:id/status", async (c) => {
      const body = statusBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json(invalidBody(body.error), 400)
      try {
        await credentials.updateCredentialStatus(c.req.param("id"), body.data.status, body.data.error)
        return c.json({ ok: true })
      } catch {
        return c.json(errorBody("credential_status_update_failed", "Failed to update credential status"), 500)
      }
    })
    .delete("/:id", async (c) => {
      const deleted = await credentials.deleteCredential(c.req.param("id"))
      return c.json({ deleted })
    })
    .delete("/provider/:providerId", async (c) => {
      const count = await credentials.deleteCredentialsByProvider(c.req.param("providerId"))
      return c.json({ deleted: count })
    })
}
