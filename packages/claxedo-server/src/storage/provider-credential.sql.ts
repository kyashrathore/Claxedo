import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

export const ClaxedoProviderCredentialTable = sqliteTable(
  "claxedo_provider_credential",
  {
    id: text().primaryKey(),
    provider_id: text().notNull(),
    kind: text().notNull(), // api_key | oauth_token | subscription_session | sandbox_provider
    source: text().notNull(), // managed | local_only | env | upstream_sync
    label: text(),
    account_id: text(),
    secure_ref: text(), // opaque backend reference — never contains raw secret material
    status: text().notNull().default("available"), // available | expired | revoked | error
    expires_at: integer(),
    last_validated_at: integer(),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index("claxedo_provider_credential_provider_idx").on(table.provider_id),
    index("claxedo_provider_credential_status_idx").on(table.status),
    index("claxedo_provider_credential_updated_idx").on(table.updated_at),
  ],
)
