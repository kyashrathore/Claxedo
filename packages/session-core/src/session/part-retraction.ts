import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import type { SqliteDatabase } from "../sqlite/database"

type Retraction = Extract<AgentPresentationEvent, { type: "message.part.retracted" }>["properties"]

export function retractStoredParts(db: SqliteDatabase, retraction: Retraction, write: (part: Record<string, unknown>) => void) {
  const read = db.prepare<{ data_json: string }>("SELECT data_json FROM part WHERE id = ? AND session_id = ? AND message_id = ?")
  for (const ref of retraction.parts) {
    const row = read.get(ref.partID, retraction.sessionID, ref.messageID)
    const part = row ? asRecord(JSON.parse(row.data_json)) : undefined
    if (part?.type === "text" || part?.type === "reasoning") write({ ...part, retracted: { reason: retraction.reason } })
  }
}
