import { ulid } from "ulid";
import { computeNextRun } from "./cron";
import type { RecurringTrigger, CreateTriggerInput, UpdateTriggerInput } from "./types";

// ---------------------------------------------------------------------------
// Schema helpers (called from app.ts initializeDb)
// ---------------------------------------------------------------------------

/**
 * Create the `triggers` table if it does not already exist.
 * Triggers are mutable config records — NOT event-sourced.
 * Runs spawned by a trigger link back via `runs_current.trigger_id`.
 */
export function initTriggersTable(db: any): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      schedule TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      runtime_type_hint TEXT NOT NULL DEFAULT 'task',
      template_id TEXT,
      fanout_mode TEXT NOT NULL DEFAULT 'single',
      payload TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createTrigger(db: any, input: CreateTriggerInput): RecurringTrigger {
  const now = new Date().toISOString();
  const id = `trig_${ulid()}`;
  const enabled = input.enabled !== false; // default true
  const next_run_at = computeNextRun(input.schedule).toISOString();

  db.run(
    `INSERT INTO triggers (id, title, schedule, enabled, runtime_type_hint, template_id, fanout_mode, payload, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.title,
      input.schedule,
      enabled ? 1 : 0,
      input.runtime_type_hint ?? "task",
      input.template_id ?? null,
      input.fanout_mode ?? "single",
      input.payload ? JSON.stringify(input.payload) : null,
      next_run_at,
      now,
      now,
    ],
  );

  return getTrigger(db, id)!;
}

export function getTrigger(db: any, id: string): RecurringTrigger | undefined {
  const row = db.query("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  return row ? rowToTrigger(row) : undefined;
}

export function listTriggers(db: any): RecurringTrigger[] {
  const rows = db.query("SELECT * FROM triggers ORDER BY created_at ASC").all() as any[];
  return rows.map(rowToTrigger);
}

export function updateTrigger(
  db: any,
  id: string,
  input: UpdateTriggerInput,
): RecurringTrigger {
  const existing = getTrigger(db, id);
  if (!existing) throw new Error(`Trigger '${id}' not found`);

  const sets: string[] = [];
  const values: any[] = [];

  if (input.title !== undefined) { sets.push("title = ?"); values.push(input.title); }
  if (input.enabled !== undefined) { sets.push("enabled = ?"); values.push(input.enabled ? 1 : 0); }
  if (input.runtime_type_hint !== undefined) { sets.push("runtime_type_hint = ?"); values.push(input.runtime_type_hint); }
  if (input.fanout_mode !== undefined) { sets.push("fanout_mode = ?"); values.push(input.fanout_mode); }
  if (input.template_id !== undefined) { sets.push("template_id = ?"); values.push(input.template_id ?? null); }
  if (input.payload !== undefined) { sets.push("payload = ?"); values.push(input.payload ? JSON.stringify(input.payload) : null); }

  if (input.schedule !== undefined) {
    sets.push("schedule = ?");
    values.push(input.schedule);
    sets.push("next_run_at = ?");
    values.push(computeNextRun(input.schedule).toISOString());
  }

  const now = new Date().toISOString();
  sets.push("updated_at = ?");
  values.push(now);

  if (sets.length === 1) return existing; // only updated_at, nothing changed

  values.push(id);
  db.run(`UPDATE triggers SET ${sets.join(", ")} WHERE id = ?`, values);

  return getTrigger(db, id)!;
}

export function deleteTrigger(db: any, id: string): void {
  const existing = getTrigger(db, id);
  if (!existing) throw new Error(`Trigger '${id}' not found`);
  db.run("DELETE FROM triggers WHERE id = ?", [id]);
}

/** Called after a trigger fires to update last/next timestamps. */
export function recordTriggerFired(db: any, id: string): void {
  const existing = getTrigger(db, id);
  if (!existing) return;

  const now = new Date().toISOString();
  const next = computeNextRun(existing.schedule).toISOString();

  db.run(
    "UPDATE triggers SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
    [now, next, now, id],
  );
}

/** Returns all runs spawned by a given trigger, newest first. */
export function listRunsByTrigger(db: any, triggerId: string): any[] {
  return db
    .query("SELECT * FROM runs_current WHERE trigger_id = ? ORDER BY rowid DESC")
    .all(triggerId) as any[];
}

/** Returns all enabled triggers whose next_run_at <= now. */
export function getDueTriggers(db: any, now: Date = new Date()): RecurringTrigger[] {
  const rows = db
    .query(
      "SELECT * FROM triggers WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
    )
    .all(now.toISOString()) as any[];
  return rows.map(rowToTrigger);
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToTrigger(row: any): RecurringTrigger {
  return {
    id: row.id,
    title: row.title,
    schedule: row.schedule,
    enabled: row.enabled === 1,
    runtime_type_hint: row.runtime_type_hint,
    template_id: row.template_id ?? undefined,
    fanout_mode: row.fanout_mode,
    payload: row.payload ? JSON.parse(row.payload) : undefined,
    last_run_at: row.last_run_at ?? undefined,
    next_run_at: row.next_run_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
