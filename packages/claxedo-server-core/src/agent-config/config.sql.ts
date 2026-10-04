import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ClaxedoUserAgentConfigTable = sqliteTable("claxedo_user_agent_config", {
  user_id: text().primaryKey(),
  config_json: text().notNull(),
  updated_at: integer().notNull(),
})
