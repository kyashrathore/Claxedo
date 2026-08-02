import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

/**
 * The named single-tenant credential partition.
 *
 * Self-host without signed/cloud auth has no organization concept, so its
 * credentials live in ONE explicitly named partition rather than in an
 * implicit "no org = everything" wildcard. Every query in the registry is
 * `WHERE org_id = <scope>`; a caller that resolves no org resolves to THIS
 * value, so a missed call site can only fail closed (it sees the single-tenant
 * partition) — it can never widen into another tenant's rows.
 *
 * Value matches the `__local__` sentinel `routes/documents.ts` already uses for
 * the same loopback/unsigned case, so the two org-scoped surfaces read alike.
 */
export const SINGLE_TENANT_ORG = "__local__"

export const ClaxedoProviderCredentialTable = sqliteTable(
  "claxedo_provider_credential",
  {
    id: text().primaryKey(),
    /**
     * Owning tenant. NOT NULL with a `__local__` default: a credential without
     * a tenant is exactly the cross-org bug this column closes, and NULL would
     * force every predicate to grow a "…OR org_id IS NULL" escape hatch — which
     * is the wildcard by another name.
     */
    org_id: text().notNull().default(SINGLE_TENANT_ORG),
    provider_id: text().notNull(),
    kind: text().notNull(), // api_key | oauth_token | subscription_session | sandbox_driver
    source: text().notNull(), // managed | local_only | env | upstream_sync
    label: text(),
    account_id: text(),
    secure_ref: text(), // opaque backend reference — never contains raw secret material
    status: text().notNull().default("available"), // available | expired | revoked | error
    health: text(), // ok | auth_failed | no_billing | rate_capped | expired
    expires_at: integer(),
    last_validated_at: integer(),
    scope: text().notNull().default("local"), // local | shared
    consent_json: text(),
    last_used_at: integer(),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_provider_credential_provider_idx").on(table.provider_id),
    index("claxedo_provider_credential_status_idx").on(table.status),
    index("claxedo_provider_credential_updated_idx").on(table.updated_at),
    index("claxedo_provider_credential_org_idx").on(table.org_id),
    index("claxedo_provider_credential_org_provider_idx").on(table.org_id, table.provider_id),
  ],
)
