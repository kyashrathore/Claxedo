import { and, eq } from "drizzle-orm"
import { ClaxedoDB } from "../../platform/db/index"
import { readTurnMeterState, type TurnMeterStateStore } from "../turn-meter-state"
import { ClaxedoUsageTurnMeterStateTable } from "../usage.sql"

type Database = { use<T>(callback: (db: ClaxedoDB.Client) => T): T }

export function createSqliteTurnMeterStateStore(input: { database?: Database } = {}): TurnMeterStateStore {
  const database = input.database ?? ClaxedoDB
  return {
    async load({ sessionId, messageId }) {
      const row = database.use((db) =>
        db
          .select()
          .from(ClaxedoUsageTurnMeterStateTable)
          .where(
            and(
              eq(ClaxedoUsageTurnMeterStateTable.session_id, sessionId),
              eq(ClaxedoUsageTurnMeterStateTable.message_id, messageId),
            ),
          )
          .get(),
      )
      if (!row) return undefined
      try {
        return readTurnMeterState(JSON.parse(row.streams_json), JSON.parse(row.observation_keys_json))
      } catch {
        return undefined
      }
    },
    async save({ sessionId, messageId, state }) {
      const values = {
        streams_json: JSON.stringify(state.streams),
        observation_keys_json: JSON.stringify(state.lastObservationKeys),
      }
      database.use((db) =>
        db
          .insert(ClaxedoUsageTurnMeterStateTable)
          .values({ session_id: sessionId, message_id: messageId, ...values })
          .onConflictDoUpdate({
            target: [ClaxedoUsageTurnMeterStateTable.session_id, ClaxedoUsageTurnMeterStateTable.message_id],
            set: values,
          })
          .run(),
      )
    },
  }
}
