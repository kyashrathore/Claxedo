import { ulid } from "ulid"
import type { EventEnvelope } from "../orchestrator/events"
import { generateHash, getNextSeq, insertEvent } from "./helpers"
import { attachSource } from "./source"
import type { RunSourceInput } from "../model/types"

export function createRunInDb(
  db: any,
  runId: string,
  goal: string,
  status = "active",
  src?: RunSourceInput,
  sourceId?: string,
): void {
  const now = new Date().toISOString()
  const eventId = `evt_${ulid()}`
  const seq = getNextSeq(db, runId)
  const event: EventEnvelope = {
    id: eventId,
    run_id: runId,
    stream_id: runId,
    stream_seq: seq,
    logical_ts: seq,
    schema_version: 1,
    type: "run_created",
    payload_json: JSON.stringify({ goal, status }),
    actor_type: "user",
    actor_id: "api",
    op_id: `op_${eventId}`,
    prev_hash: "00000000",
    hash: generateHash(),
    created_at: now,
  }

  insertEvent(db, event)
  db.run("INSERT INTO runs_current (run_id, goal, status, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
    runId,
    goal,
    status,
    sourceId ?? null,
    now,
    now,
  ])

  if (!src) return
  attachSource(db, runId, src)
}
