import { ulid } from "ulid"
import type { IEventStore } from "../orchestrator/core/services/event-store"
import { attachSource } from "./source"
import type { RunSourceInput } from "../model/types"

export async function createRunInDb(
  db: any,
  eventStore: IEventStore,
  runId: string,
  goal: string,
  status = "active",
  src?: RunSourceInput,
  sourceId?: string,
): Promise<void> {
  const now = new Date().toISOString()
  const eventId = `evt_${ulid()}`

  await eventStore.append({
    id: eventId,
    run_id: runId,
    stream_id: runId,
    schema_version: 1,
    type: "run_created",
    payload_json: JSON.stringify({ goal, status }),
    actor_type: "user",
    actor_id: "api",
    op_id: `op_${eventId}`,
    created_at: now,
  })

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
