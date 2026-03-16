/**
 * ITriggerStore — DB-agnostic interface for recurring trigger CRUD.
 *
 * Follows the same interface + implementation + factory pattern as IEventStore:
 *   ITriggerStore  →  SqliteTriggerStore  →  openSqliteTriggerStore(db)
 */

import type { Database } from "bun:sqlite";
import {
  createTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
  deleteTrigger,
  listRunsByTrigger,
  getDueTriggers,
  recordTriggerFired,
} from "./store";
import type { RecurringTrigger, CreateTriggerInput, UpdateTriggerInput } from "./types";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ITriggerStore {
  /** Create a new trigger. Returns the created record. */
  create(input: CreateTriggerInput): RecurringTrigger;
  /** Get a single trigger by ID. Returns undefined if not found. */
  get(id: string): RecurringTrigger | undefined;
  /** List all triggers ordered by creation date. */
  list(): RecurringTrigger[];
  /** Update mutable fields on a trigger. Returns the updated record. */
  update(id: string, input: UpdateTriggerInput): RecurringTrigger;
  /** Delete a trigger by ID. Throws if not found. */
  delete(id: string): void;
  /** List all runs spawned by a trigger, newest first. */
  listRunsByTrigger(triggerId: string): any[];
  /** Return all enabled triggers whose next_run_at <= now. */
  getDue(now?: Date): RecurringTrigger[];
  /** Update last_run_at and next_run_at after a trigger fires. */
  recordFired(id: string): void;
}

// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

class SqliteTriggerStore implements ITriggerStore {
  constructor(private db: Database) {}

  create(input: CreateTriggerInput): RecurringTrigger {
    return createTrigger(this.db, input);
  }

  get(id: string): RecurringTrigger | undefined {
    return getTrigger(this.db, id);
  }

  list(): RecurringTrigger[] {
    return listTriggers(this.db);
  }

  update(id: string, input: UpdateTriggerInput): RecurringTrigger {
    return updateTrigger(this.db, id, input);
  }

  delete(id: string): void {
    return deleteTrigger(this.db, id);
  }

  listRunsByTrigger(triggerId: string): any[] {
    return listRunsByTrigger(this.db, triggerId);
  }

  getDue(now?: Date): RecurringTrigger[] {
    return getDueTriggers(this.db, now);
  }

  recordFired(id: string): void {
    return recordTriggerFired(this.db, id);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an ITriggerStore backed by the given bun:sqlite Database instance. */
export function openSqliteTriggerStore(db: Database): ITriggerStore {
  return new SqliteTriggerStore(db);
}
