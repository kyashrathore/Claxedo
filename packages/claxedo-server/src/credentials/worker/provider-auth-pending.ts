import { z } from "zod"
import { envelopeCipher, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import { DEFAULT_PENDING_TTL_MS, type ProviderAuthPendingStore } from "@claxedo/server-core/credentials/provider-auth/service"
import type { HostedCredentialDatabase } from "./index"

const pendingAuthorization = z.object({
  providerId: z.enum(["codex-app-server", "openai"]),
  org: z.string().min(1),
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
  intervalMs: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
})

/**
 * A device login's callback can land on a different Worker instance than its
 * authorize did, so the attempt waits in D1, sealed under its organization's
 * key like a stored credential: the device code completes a login.
 */
export function d1ProviderAuthPending(
  database: HostedCredentialDatabase,
  env: Record<string, string | undefined>,
  now: () => number = Date.now,
): ProviderAuthPendingStore {
  const keys = envelopeKeyProviderFromEnv(env)
  const cipherFor = (orgId: string) => envelopeCipher(keys, { orgId })
  return {
    put: async (key, pending) => {
      const sealed = await cipherFor(pending.org).seal(key, JSON.stringify(pending))
      await database.prepare("delete from hosted_provider_auth_attempts where org_id = ? and expires_at <= ?").bind(pending.org, now()).run()
      await database
        .prepare(`insert into hosted_provider_auth_attempts (id, org_id, secret_envelope, expires_at) values (?, ?, ?, ?)
          on conflict (id) do update set org_id = excluded.org_id, secret_envelope = excluded.secret_envelope, expires_at = excluded.expires_at`)
        .bind(key, pending.org, sealed, pending.startedAt + DEFAULT_PENDING_TTL_MS)
        .run()
    },
    take: async (key) => {
      const row = await database
        .prepare("delete from hosted_provider_auth_attempts where id = ? returning org_id, secret_envelope, expires_at")
        .bind(key)
        .first()
      if (!row) return undefined
      if (typeof row.org_id !== "string" || typeof row.secret_envelope !== "string" || typeof row.expires_at !== "number") {
        throw new Error("A provider login attempt row is malformed")
      }
      if (row.expires_at <= now()) return undefined
      const pending = pendingAuthorization.parse(JSON.parse(await cipherFor(row.org_id).open(key, row.secret_envelope)))
      if (pending.org !== row.org_id) throw new Error("A provider login attempt is sealed for another organization")
      return pending
    },
  }
}
