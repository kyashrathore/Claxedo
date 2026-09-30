import type { D1Database } from "@cloudflare/workers-types"
import type { FindAccountByEmail } from "@claxedo/server-core/platform/auth/org-access-authority"

/**
 * The Better Auth account whose verified address this is, named the way the
 * control plane's identity rows name it (`issuer|subject`). The address lives
 * only in AUTH_DB, which the authority never reads. An unverified address
 * names nobody: whoever typed it at sign-up need not own it.
 */
export function createBetterAuthD1AccountEmailResolver(database: D1Database, issuer: string): FindAccountByEmail {
  return async (email) => {
    const row = await database
      .prepare(`select account.id from user as account where lower(account.email) = ? and account."emailVerified" = 1`)
      .bind(email.trim().toLowerCase())
      .first<{ id: string }>()
    return row ? { tokenIdentifier: `${issuer}|${row.id}` } : undefined
  }
}
