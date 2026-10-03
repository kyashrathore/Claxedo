import { ACCOUNT_SCOPES } from "@claxedo/account-contract/vocabulary"
import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import {
  CREDENTIAL_HEALTHS,
  CREDENTIAL_KINDS,
  CREDENTIAL_SOURCES,
  CREDENTIAL_STATUSES,
} from "./types"
import { SINGLE_TENANT_ORG } from "./partition"


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
    /**
     * The person whose account this is. NULL is the org's own row: an org
     * account a person spends for a provider they chose it for, or a
     * connection, sandbox-driver or deployment secret no person owns. It is a
     * value rather than an absence: it sorts alongside personal rows in the
     * same uniqueness rule instead of escaping it.
     */
    owner: text(),
    provider_id: text().notNull(),
    kind: text({ enum: CREDENTIAL_KINDS }).notNull(),
    source: text({ enum: CREDENTIAL_SOURCES }).notNull(),
    label: text(),
    account_id: text(),
    secure_ref: text(), // opaque backend reference — never contains raw secret material
    status: text({ enum: CREDENTIAL_STATUSES }).notNull().default("available"),
    health: text({ enum: CREDENTIAL_HEALTHS }),
    expires_at: integer(),
    last_validated_at: integer(),
    scope: text({ enum: ACCOUNT_SCOPES }).notNull().default("local"),
    consent_json: text(),
    /** The account a harness runs on; at most one per (org_id, owner, provider_id). */
    is_active: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * When that mark was last set. Its own column because `updated_at` moves on
     * a health check and a rename too, and delivery resolves a vendor host two
     * marked accounts both answer on by taking the one stated most recently —
     * so reading `updated_at` let a Check move the host to the account nobody
     * chose.
     */
    activated_at: integer(),
    last_used_at: integer(),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    /**
     * Which stored secret a request used. `updated_at` cannot answer that: two
     * writes inside one millisecond share it, so a 401 for the superseded value
     * withdraws the new one. This counts secret writes and nothing else, so a
     * status or scope edit leaves live bindings alone.
     */
    revision: integer().notNull().default(1),
    /**
     * The quota windows of the last usage read, as the JSON array the verifier
     * hands back. A vendor names its own windows and adds new ones, so the
     * shape is the vendor's to widen and columns here would have to be migrated
     * each time one is.
     */
    usage_windows: text(),
    /** When `usage_windows` was read. Neither column is meaningful alone. */
    usage_at: integer(),
  },
  (table) => [
    index("claxedo_provider_credential_provider_idx").on(table.provider_id),
    index("claxedo_provider_credential_status_idx").on(table.status),
    index("claxedo_provider_credential_updated_idx").on(table.updated_at),
    index("claxedo_provider_credential_org_idx").on(table.org_id),
    index("claxedo_provider_credential_org_provider_idx").on(table.org_id, table.provider_id),
    /**
     * SQLite treats NULLs as distinct in a unique index, so a bare `owner`
     * column would let a provider hold any number of active org rows while
     * enforcing the rule only for personal ones. `coalesce` gives the org
     * owner a value the index can collide on.
     */
    uniqueIndex("claxedo_provider_credential_active_idx")
      .on(table.org_id, sql`coalesce(${table.owner}, '')`, table.provider_id)
      .where(sql`${table.is_active} = 1`),
  ],
)
