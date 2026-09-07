import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import { SINGLE_TENANT_ORG } from "./provider-credential.sql"

/**
 * OpenAI-compatible providers an operator declared by hand.
 *
 * The row holds configuration only. The provider's API key is a credential and
 * lives in `claxedo_provider_credential` under the same `(org_id,
 * provider_id)`, so a config read can never disclose secret material.
 *
 * Keyed by `(org_id, provider_id)` rather than a surrogate id: the provider id
 * IS the identity the catalog, the credential registry and the model picker all
 * join on, and one org declaring `acme` must not collide with another's.
 */
export const ClaxedoCustomProviderTable = sqliteTable(
  "claxedo_custom_provider",
  {
    org_id: text().notNull().default(SINGLE_TENANT_ORG),
    provider_id: text().notNull(),
    name: text().notNull(),
    base_url: text().notNull(),
    /** Environment variable names the engine may read the key from. */
    env_json: text().notNull().default("[]"),
    /** Non-secret request headers, name → value. */
    headers_json: text().notNull().default("{}"),
    /** Model id → display name. */
    models_json: text().notNull().default("{}"),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.org_id, table.provider_id] })],
)
