import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823234255_part_order",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`__new_part\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // Legacy part rows did not persist producer order. SQLite rowid is the
      // only surviving insertion chronology, so use it once for the backfill.
      // All writes after this migration persist an authoritative ordinal.
      yield* tx.run(`
        INSERT INTO \`__new_part\` (
          \`id\`, \`message_id\`, \`session_id\`, \`ordinal\`, \`time_created\`, \`time_updated\`, \`data\`
        )
        SELECT
          \`id\`,
          \`message_id\`,
          \`session_id\`,
          ROW_NUMBER() OVER (PARTITION BY \`message_id\` ORDER BY \`rowid\`) - 1,
          \`time_created\`,
          \`time_updated\`,
          \`data\`
        FROM \`part\`;
      `)
      yield* tx.run(`DROP TABLE \`part\`;`)
      yield* tx.run(`ALTER TABLE \`__new_part\` RENAME TO \`part\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`part_message_id_id_idx\`;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`part_message_ordinal_idx\` ON \`part\` (\`message_id\`,\`ordinal\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
