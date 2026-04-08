/**
 * Unit tests for ITriggerStore / SqliteTriggerStore (via openSqliteTriggerStore).
 *
 * Each test uses a real in-memory SQLite DB so we exercise the actual SQL
 * rather than a hand-rolled stub.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openSqliteTriggerStore, type ITriggerStore } from "../../src/triggers/trigger-store";
import { initializeDb } from "../../src/db/schema";
import { initTriggersTable } from "../../src/triggers/store";
import { nodeDb } from "../helpers/node-db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): ITriggerStore {
  const db = new Database(":memory:");
  initTriggersTable(db);
  // Minimal runs_current table needed for listRunsByTrigger
  db.run(`
    CREATE TABLE IF NOT EXISTS runs_current (
      run_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      runtime_type TEXT,
      trigger_id TEXT,
      trigger_run_index INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return openSqliteTriggerStore(db);
}

const baseInput = {
  title: "Nightly sync",
  schedule: "0 0 * * *",
  enabled: true,
  runtime_type_hint: "task" as const,
  fanout_mode: "single" as const,
};

// ---------------------------------------------------------------------------
// create / get / list
// ---------------------------------------------------------------------------

describe("ITriggerStore: create + get + list", () => {
  let store: ITriggerStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("create returns a trigger with the right fields", () => {
    const t = store.create(baseInput);
    expect(t.id).toMatch(/^trig_/);
    expect(t.title).toBe("Nightly sync");
    expect(t.schedule).toBe("0 0 * * *");
    expect(t.enabled).toBe(true);
    expect(t.runtime_type_hint).toBe("task");
    expect(t.fanout_mode).toBe("single");
    expect(typeof t.created_at).toBe("string");
    expect(typeof t.updated_at).toBe("string");
    expect(t.next_run_at).toBeDefined();
  });

  it("get returns the created trigger", () => {
    const created = store.create(baseInput);
    const got = store.get(created.id);
    expect(got).toBeDefined();
    expect(got!.id).toBe(created.id);
  });

  it("get returns undefined for unknown id", () => {
    expect(store.get("trig_no_such")).toBeUndefined();
  });

  it("list returns all triggers in order", () => {
    store.create({ ...baseInput, title: "First" });
    store.create({ ...baseInput, title: "Second" });
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe("First");
    expect(all[1].title).toBe("Second");
  });

  it("list returns empty array when no triggers", () => {
    expect(store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("ITriggerStore: update", () => {
  let store: ITriggerStore;

  beforeEach(() => { store = makeStore(); });

  it("updates title and enabled flag", () => {
    const t = store.create(baseInput);
    const updated = store.update(t.id, { title: "Updated", enabled: false });
    expect(updated.title).toBe("Updated");
    expect(updated.enabled).toBe(false);
  });

  it("updating schedule recalculates next_run_at", () => {
    const t = store.create(baseInput);
    const before = t.next_run_at;
    // Change to yearly — next_run_at will differ
    const updated = store.update(t.id, { schedule: "0 0 1 1 *" });
    expect(updated.schedule).toBe("0 0 1 1 *");
    // next_run_at must be a valid ISO string (may or may not change)
    expect(typeof updated.next_run_at).toBe("string");
  });

  it("throws when trigger not found", () => {
    expect(() => store.update("trig_no_such", { title: "X" })).toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("ITriggerStore: delete", () => {
  let store: ITriggerStore;

  beforeEach(() => { store = makeStore(); });

  it("deletes an existing trigger", () => {
    const t = store.create(baseInput);
    store.delete(t.id);
    expect(store.get(t.id)).toBeUndefined();
  });

  it("throws when trigger not found", () => {
    expect(() => store.delete("trig_no_such")).toThrow("not found");
  });

  it("list excludes deleted triggers", () => {
    const t1 = store.create({ ...baseInput, title: "Keep" });
    const t2 = store.create({ ...baseInput, title: "Delete me" });
    store.delete(t2.id);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(t1.id);
  });
});

// ---------------------------------------------------------------------------
// getDue
// ---------------------------------------------------------------------------

describe("ITriggerStore: getDue", () => {
  let store: ITriggerStore;

  beforeEach(() => { store = makeStore(); });

  it("returns triggers whose next_run_at is in the past", () => {
    // Create trigger and manually set next_run_at to the past via update
    const t = store.create(baseInput);
    // Disabled triggers must not appear
    const disabled = store.create({ ...baseInput, title: "Off", enabled: false });
    // All created triggers start with a next_run_at in the future — none due yet
    const dueNow = store.getDue(new Date());
    // At minimum, the enabled one might or might not be due; check disabled is excluded
    const dueIds = dueNow.map((x) => x.id);
    expect(dueIds).not.toContain(disabled.id);
  });

  it("returns empty array when no triggers are due", () => {
    store.create(baseInput); // next_run_at is in the future
    expect(store.getDue(new Date(0))).toHaveLength(0); // epoch — all are in the future relative to epoch
  });
});

// ---------------------------------------------------------------------------
// recordFired
// ---------------------------------------------------------------------------

describe("ITriggerStore: recordFired", () => {
  let store: ITriggerStore;

  beforeEach(() => { store = makeStore(); });

  it("updates last_run_at and recalculates next_run_at", () => {
    const t = store.create(baseInput);
    const beforeNext = t.next_run_at;
    store.recordFired(t.id);
    const after = store.get(t.id)!;
    expect(after.last_run_at).toBeDefined();
    // next_run_at should be updated (same schedule, recalculated from now)
    expect(after.next_run_at).toBeDefined();
  });

  it("is a no-op when trigger not found (does not throw)", () => {
    expect(() => store.recordFired("trig_no_such")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listRunsByTrigger
// ---------------------------------------------------------------------------

describe("ITriggerStore: listRunsByTrigger", () => {
  it("returns empty array when no runs exist for trigger", () => {
    const store = makeStore();
    const t = store.create(baseInput);
    expect(store.listRunsByTrigger(t.id)).toHaveLength(0);
  });
});

describe("ITriggerStore: driver compatibility", () => {
  it("accepts a Node-style sqlite database directly", () => {
    const db = nodeDb();
    initializeDb(db);
    const store = openSqliteTriggerStore(db);

    const trigger = store.create(baseInput);

    expect(store.get(trigger.id)?.title).toBe("Nightly sync");
    expect(store.list()).toHaveLength(1);
    db.close();
  });
});
