/**
 * Credential management routes.
 *
 * Provides a dedicated API surface for listing, creating, and deleting
 * managed credentials. Used by the UI settings panels.
 */

import { Hono } from "hono"
import { z } from "zod"
import {
  listCredentials,
  getCredentialByProvider,
  putCredential,
  deleteCredential,
  deleteCredentialsByProvider,
  updateCredentialStatus,
} from "../credentials/registry"
import { syncLocalCredentials } from "../credentials/sync"
import type { CredentialKind, CredentialSource, CredentialStatus } from "../credentials/types"

const putBody = z.object({
  provider_id: z.string().min(1),
  kind: z.enum(["api_key", "oauth_token", "subscription_session", "sandbox_provider"]),
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

function redact(cred: ReturnType<typeof getCredentialByProvider>) {
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

export function CredentialRoutes() {
  return new Hono()
    .get("/", (c) => {
      const creds = listCredentials().map(redact)
      return c.json({ credentials: creds })
    })
    .get("/:providerId", (c) => {
      const cred = getCredentialByProvider(c.req.param("providerId"))
      if (!cred) return c.json({ credential: null })
      return c.json({ credential: redact(cred) })
    })
    .put("/", async (c) => {
      const body = putBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      try {
        const cred = await putCredential(body.data)
        return c.json({ credential: redact(cred) })
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Failed to store credential" }, 500)
      }
    })
    .post("/sync-local", async (c) => {
      const body = syncBody.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      try {
        const result = await syncLocalCredentials(body.data.provider_ids)
        return c.json(result)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : "Failed to sync local credentials" }, 500)
      }
    })
    .patch("/:id/status", async (c) => {
      const body = statusBody.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: body.error.message }, 400)
      updateCredentialStatus(c.req.param("id"), body.data.status, body.data.error)
      return c.json({ ok: true })
    })
    .delete("/:id", async (c) => {
      const deleted = await deleteCredential(c.req.param("id"))
      return c.json({ deleted })
    })
    .delete("/provider/:providerId", async (c) => {
      const count = await deleteCredentialsByProvider(c.req.param("providerId"))
      return c.json({ deleted: count })
    })
}
