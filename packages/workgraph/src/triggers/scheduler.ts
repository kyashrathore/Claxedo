import { ulid } from "ulid";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import { getTrigger, getDueTriggers, recordTriggerFired } from "./store";
import type { RecurringTrigger } from "./types";

// ---------------------------------------------------------------------------
// fireTrigger — creates a run from a trigger's spec
// ---------------------------------------------------------------------------

export interface FireTriggerResult {
  run_id: string;
  trigger_id: string;
  goal: string;
  trigger_run_index: number;
}

/**
 * Fire a trigger: create one (or more, for fanout) runs linked back to the
 * trigger via `trigger_id`.  Updates `last_run_at` / `next_run_at` on the
 * trigger record.
 *
 * Returns the list of run records created (usually length 1 for 'single' mode).
 */
export function fireTrigger(db: any, triggerId: string): FireTriggerResult[] {
  const trigger = getTrigger(db, triggerId);
  if (!trigger) throw new Error(`Trigger '${triggerId}' not found`);
  if (!trigger.enabled) throw new Error(`Trigger '${triggerId}' is disabled`);

  const items = buildSpawnItems(trigger);
  const results: FireTriggerResult[] = [];

  for (const item of items) {
    const run_id = `run_${ulid()}`;
    const eventId = `evt_${ulid()}`;
    const seq = getNextSeq(db, run_id);
    const now = new Date().toISOString();

    const goal = buildGoal(trigger, item.index);

    // Write run_created event
    const event = {
      id: eventId,
      run_id,
      stream_id: run_id,
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      type: "run_created",
      payload_json: JSON.stringify({
        goal,
        status: "active",
        trigger_id: triggerId,
        trigger_run_index: item.index,
      }),
      actor_type: "trigger" as const,
      actor_id: triggerId,
      op_id: `op_${eventId}`,
      prev_hash: "00000000",
      hash: generateHash(),
      created_at: now,
    };
    insertEvent(db, event);

    // Write to runs_current, including trigger FK columns
    db.run(
      `INSERT INTO runs_current (run_id, goal, status, runtime_type, trigger_id, trigger_run_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [run_id, goal, "active", trigger.runtime_type_hint, triggerId, item.index, now, now],
    );

    // Append a trace event for observability
    const traceId = `trace_${ulid()}`;
    db.run(
      `INSERT INTO trace_events (id, event_type, timestamp, run_id, node_id, payload_json)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        traceId,
        "trigger_spawned",
        now,
        run_id,
        JSON.stringify({ trigger_id: triggerId, trigger_run_index: item.index, schedule: trigger.schedule }),
      ],
    );

    results.push({ run_id, trigger_id: triggerId, goal, trigger_run_index: item.index });
  }

  // Update trigger timestamps
  recordTriggerFired(db, triggerId);

  return results;
}

// ---------------------------------------------------------------------------
// TriggerScheduler — setInterval-based local scheduler
// ---------------------------------------------------------------------------

export interface TriggerSchedulerOptions {
  /** How often (ms) to poll for due triggers. Default: 60_000 (1 minute). */
  pollIntervalMs?: number;
}

/**
 * Local dev / self-hosted scheduler.
 * Polls the DB every `pollIntervalMs` ms and fires any enabled triggers whose
 * `next_run_at` has passed.
 *
 * In production/cloud, Inngest would replace this by calling
 * `POST /triggers/:id/fire` on the registered cron schedule.
 */
export class TriggerScheduler {
  private db: any;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  constructor(db: any, opts: TriggerSchedulerOptions = {}) {
    this.db = db;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  }

  /** Start polling. Idempotent — calling start() twice is safe. */
  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => this.tick(), this.pollIntervalMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Manually trigger a single poll cycle (useful in tests). */
  tick(): FireTriggerResult[][] {
    const due = getDueTriggers(this.db);
    const allResults: FireTriggerResult[][] = [];
    for (const trigger of due) {
      try {
        const results = fireTrigger(this.db, trigger.id);
        allResults.push(results);
      } catch (err) {
        console.error(`[TriggerScheduler] Failed to fire trigger ${trigger.id}:`, err);
      }
    }
    return allResults;
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SpawnItem {
  index: number;
  payload?: Record<string, unknown>;
}

function buildSpawnItems(trigger: RecurringTrigger): SpawnItem[] {
  if (trigger.fanout_mode === "fanout" && Array.isArray(trigger.payload)) {
    // Fan out: one run per element in the payload array
    return (trigger.payload as unknown as Record<string, unknown>[]).map((p, i) => ({
      index: i,
      payload: p,
    }));
  }
  // Single mode (or payload is not an array)
  return [{ index: 0, payload: trigger.payload }];
}

function buildGoal(trigger: RecurringTrigger, _index: number): string {
  // Use the trigger title as the run goal; in production an LLM or template
  // would expand this from trigger.template_id + trigger.payload.
  return trigger.title;
}
