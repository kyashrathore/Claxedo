import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260713090000_session_tools",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`tools\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
