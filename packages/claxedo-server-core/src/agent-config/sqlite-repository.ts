import { eq } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db"
import { emptyUserAgentConfig, validateUserAgentConfig, type UserAgentConfig } from "./config"
import { ClaxedoUserAgentConfigTable } from "./config.sql"
import { createHarnessConnectionSchema } from "./connections"
import type { UserAgentConfigRepository } from "./repository"

export function sqliteUserAgentConfigRepository(
  connections: ReturnType<typeof createHarnessConnectionSchema>,
): UserAgentConfigRepository {
 return {
  async read(userId) {
    const row = ClaxedoDB.use((db) => db.select({ config: ClaxedoUserAgentConfigTable.config_json })
      .from(ClaxedoUserAgentConfigTable)
      .where(eq(ClaxedoUserAgentConfigTable.user_id, userId))
      .get())
    if (!row) return emptyUserAgentConfig()
    let parsed: unknown
    try {
      parsed = JSON.parse(row.config)
    } catch {
      throw Object.assign(new Error("User agent config contains invalid JSON"), { code: "user_agent_config_invalid_json" })
    }
    return validateUserAgentConfig(parsed, connections)
  },
  async write(userId, config: UserAgentConfig) {
    const checked = validateUserAgentConfig(config, connections)
    ClaxedoDB.use((db) => db.insert(ClaxedoUserAgentConfigTable).values({
      user_id: userId,
      config_json: JSON.stringify(checked),
      updated_at: Date.now(),
    }).onConflictDoUpdate({
      target: ClaxedoUserAgentConfigTable.user_id,
      set: { config_json: JSON.stringify(checked), updated_at: Date.now() },
    }).run())
  },
 }
}
