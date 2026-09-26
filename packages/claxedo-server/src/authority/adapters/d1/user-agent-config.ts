import type { D1Database } from "@cloudflare/workers-types"
import {
  emptyUserAgentConfig,
  validateUserAgentConfig,
  type UserAgentConfig,
} from "@claxedo/server-core/agent-config/config"
import type { UserAgentConfigRepository } from "@claxedo/server-core/agent-config/repository"

export function d1UserAgentConfigRepository(database: D1Database): UserAgentConfigRepository {
  return {
    async read(userId) {
      const row = await database.prepare("select config_json from user_agent_config where user_id = ?")
        .bind(userId)
        .first<{ config_json: string }>()
      if (!row) return emptyUserAgentConfig()
      let parsed: unknown
      try {
        parsed = JSON.parse(row.config_json)
      } catch {
        throw Object.assign(new Error("User agent config contains invalid JSON"), { code: "user_agent_config_invalid_json" })
      }
      return validateUserAgentConfig(parsed)
    },
    async write(userId, config: UserAgentConfig) {
      const checked = validateUserAgentConfig(config)
      await database.prepare(
        "insert into user_agent_config (user_id, config_json, updated_at) values (?, ?, ?) " +
        "on conflict (user_id) do update set config_json = excluded.config_json, updated_at = excluded.updated_at",
      ).bind(userId, JSON.stringify(checked), Date.now()).run()
    },
  }
}
