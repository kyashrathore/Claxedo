import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

import { AccountV2 } from "../account"
import { Timestamps } from "../database/schema.sql"

export const AccountTable = sqliteTable("account", {
  id: text().$type<AccountV2.ID>().primaryKey(),
  // Legacy provider/display field. New native accounts are identified by the
  // canonical application user id below; auth-provider email is not copied
  // into the application credential store.
  email: text(),
  user_id: text(),
  url: text().notNull(),
  access_token: text().$type<AccountV2.AccessToken>().notNull(),
  refresh_token: text().$type<AccountV2.RefreshToken>().notNull(),
  token_expiry: integer(),
  // Native credentials are accepted only with the immutable deployment tuple
  // discovered from that control plane. Nullable columns preserve the local
  // row as quarantined evidence during migration; account service code refuses
  // to refresh or use any row whose tuple is incomplete.
  auth_adapter: text().$type<"better-auth">(),
  auth_deployment_id: text(),
  auth_configuration_version: text(),
  auth_issuer: text(),
  auth_token_endpoint_origin: text(),
  auth_control_plane_origin: text(),
  auth_client_id: text(),
  auth_resource: text(),
  auth_scopes: text(),
  auth_token_kind: text().$type<"access-token">(),
  ...Timestamps,
})

export const AccountStateTable = sqliteTable("account_state", {
  id: integer().primaryKey(),
  active_account_id: text()
    .$type<AccountV2.ID>()
    .references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text().$type<AccountV2.OrgID>(),
})

// LEGACY
export const ControlAccountTable = sqliteTable(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().$type<AccountV2.AccessToken>().notNull(),
    refresh_token: text().$type<AccountV2.RefreshToken>().notNull(),
    token_expiry: integer(),
    active: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
