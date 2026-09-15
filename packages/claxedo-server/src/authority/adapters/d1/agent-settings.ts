import type { D1Database } from "@cloudflare/workers-types"
import type { CrossMachineWrites } from "@claxedo/server-core/platform/auth/cross-machine-writes"
import type { AgentSettings, AgentSettingsService } from "../../../routes/account-agent-settings"

export type D1AgentSettingsOptions = Readonly<{ now?: () => number }>

export function d1AgentSettings(database: D1Database, options: D1AgentSettingsOptions = {}): AgentSettingsService {
  const now = options.now ?? Date.now
  return {
    async read(userId) {
      const row = await database
        .prepare("select cross_machine_writes from user_agent_settings where user_id = ?")
        .bind(userId)
        .first<{ cross_machine_writes: number }>()
      return { crossMachineWrites: row?.cross_machine_writes === 1 }
    },

    async write(userId, settings: AgentSettings) {
      await database
        .prepare(
          "insert into user_agent_settings (user_id, cross_machine_writes, updated_at) values (?, ?, ?)" +
            " on conflict (user_id) do update set cross_machine_writes = excluded.cross_machine_writes, updated_at = excluded.updated_at",
        )
        .bind(userId, settings.crossMachineWrites ? 1 : 0, now())
        .run()
      return settings
    },
  }
}

/** The reader a root capability minter takes: the account's own row, and an absent row is off. */
export function d1CrossMachineWrites(database: D1Database): CrossMachineWrites {
  const settings = d1AgentSettings(database)
  return async (account) => (await settings.read(account.userId)).crossMachineWrites
}
