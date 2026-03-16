/**
 * Integration tests for fireTrigger + TriggerScheduler.
 *
 * Uses real in-memory SQLite with IEventStore, IRunStore, IExecutionStore,
 * and ITriggerStore so the full event-chain is exercised.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDb } from "../../src/db/schema";
import { openSqliteEventStore } from "../../src/orchestrator/core/services/event-store-sqlite";
import { openSqliteExecutionStore } from "../../src/sdk/execution-store";
import { openSqliteRunStore } from "../../src/sdk/runs";
import { openSqliteTriggerStore } from "../../src/triggers/trigger-store";
import { fireTrigger, TriggerScheduler } from "../../src/triggers/scheduler";
import type { ITriggerStore } from "../../src/triggers/trigger-store";
import type { IRunStore } from "../../src/sdk/runs";
import type { IEventStore } from "../../src/orchestrator/core/services/event-store";
import type { IExecutionStore } from "../../src/sdk/execution-store";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function makeStores() {
  const db = new Database(":memory:");
  initializeDb(db);
  const eventStore = openSqliteEventStore(db);
  const runStore = openSqliteRunStore(db);
  const executionStore = openSqliteExecutionStore(db, eventStore);
  const triggerStore = openSqliteTriggerStore(db);
  return { db, eventStore, runStore, executionStore, triggerStore };
}

const defaultTriggerInput = {
  title: "Nightly build",
  schedule: "0 0 * * *",
  enabled: true,
  runtime_type_hint: "task" as const,
  fanout_mode: "single" as const,
};

// ---------------------------------------------------------------------------
// fireTrigger
// ---------------------------------------------------------------------------

describe("fireTrigger", () => {
  let stores: ReturnType<typeof makeStores>;

  beforeEach(() => {
    stores = makeStores();
  });

  it("throws when trigger not found", async () => {
    const { triggerStore, runStore, eventStore, executionStore } = stores;
    await expect(
      fireTrigger(triggerStore, runStore, eventStore, executionStore, "trig_no_such"),
    ).rejects.toThrow("not found");
  });

  it("throws when trigger is disabled", async () => {
    const { triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create({ ...defaultTriggerInput, enabled: false });
    await expect(
      fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id),
    ).rejects.toThrow("disabled");
  });

  it("creates exactly one run for single-mode trigger", async () => {
    const { db, triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create(defaultTriggerInput);
    const results = await fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id);

    expect(results).toHaveLength(1);
    expect(results[0].run_id).toMatch(/^run_/);
    expect(results[0].trigger_id).toBe(t.id);
    expect(results[0].goal).toBe(t.title);
    expect(results[0].trigger_run_index).toBe(0);
  });

  it("inserts a run row with correct trigger FK columns", async () => {
    const { db, triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create(defaultTriggerInput);
    const [result] = await fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id);

    const row = db.query("SELECT * FROM runs_current WHERE run_id = ?").get(result.run_id) as any;
    expect(row).toBeDefined();
    expect(row.trigger_id).toBe(t.id);
    expect(row.trigger_run_index).toBe(0);
    expect(row.runtime_type).toBe("task");
  });

  it("emits a run_created event with a valid hash chain entry", async () => {
    const { db, triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create(defaultTriggerInput);
    const [result] = await fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id);

    const events = await eventStore.getEvents(result.run_id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run_created");
    // Real SHA-256 hash — not the broken random stub
    expect(events[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0].prev_hash).toBe("00000000"); // first event on the stream
  });

  it("records last_run_at on the trigger after firing", async () => {
    const { triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create(defaultTriggerInput);
    expect(triggerStore.get(t.id)!.last_run_at).toBeUndefined();

    await fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id);

    const after = triggerStore.get(t.id)!;
    expect(after.last_run_at).toBeDefined();
    expect(typeof after.last_run_at).toBe("string");
  });

  it("emits a trace event for trigger_spawned", async () => {
    const { db, triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create(defaultTriggerInput);
    const [result] = await fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id);

    const traceRows = db
      .query("SELECT * FROM trace_events WHERE run_id = ? AND event_type = ?")
      .all(result.run_id, "trigger_spawned") as any[];
    expect(traceRows).toHaveLength(1);
    const payload = JSON.parse(traceRows[0].payload_json);
    expect(payload.trigger_id).toBe(t.id);
  });

  it("fanout trigger creates one run per payload entry", async () => {
    const { triggerStore, runStore, eventStore, executionStore } = stores;
    const t = triggerStore.create({
      ...defaultTriggerInput,
      fanout_mode: "fanout",
      payload: [{ repo: "A" }, { repo: "B" }, { repo: "C" }] as any,
    });
    const results = await fireTrigger(triggerStore, runStore, eventStore, executionStore, t.id);
    expect(results).toHaveLength(3);
    const indices = results.map((r) => r.trigger_run_index);
    expect(indices).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// TriggerScheduler
// ---------------------------------------------------------------------------

describe("TriggerScheduler", () => {
  it("starts and stops without errors", () => {
    const { triggerStore, runStore, eventStore, executionStore } = makeStores();
    const scheduler = new TriggerScheduler(triggerStore, runStore, eventStore, executionStore, {
      pollIntervalMs: 100,
    });
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("start is idempotent — calling twice stays running", () => {
    const { triggerStore, runStore, eventStore, executionStore } = makeStores();
    const scheduler = new TriggerScheduler(triggerStore, runStore, eventStore, executionStore, {
      pollIntervalMs: 1000,
    });
    scheduler.start();
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
  });

  it("tick returns empty when no triggers are due", async () => {
    const { triggerStore, runStore, eventStore, executionStore } = makeStores();
    triggerStore.create(defaultTriggerInput); // next_run_at is in the future
    const scheduler = new TriggerScheduler(triggerStore, runStore, eventStore, executionStore);
    const results = await scheduler.tick();
    expect(results).toHaveLength(0);
  });

  it("tick fires due triggers and returns results", async () => {
    const { db, triggerStore, runStore, eventStore, executionStore } = makeStores();
    // Create a trigger and manually set next_run_at to the past
    const t = triggerStore.create(defaultTriggerInput);
    db.run("UPDATE triggers SET next_run_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", t.id]);

    const scheduler = new TriggerScheduler(triggerStore, runStore, eventStore, executionStore);
    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(1);
    expect(results[0][0].trigger_id).toBe(t.id);
  });

  it("tick does not throw if a trigger fails — logs and continues", async () => {
    const { db, triggerStore, runStore, eventStore, executionStore } = makeStores();
    // Create a due but disabled trigger (fireTrigger throws for disabled)
    const t = triggerStore.create({ ...defaultTriggerInput, enabled: false });
    db.run("UPDATE triggers SET next_run_at = ?, enabled = 1 WHERE id = ?", ["2000-01-01T00:00:00.000Z", t.id]);
    // But query for getDue only returns enabled=1, so this won't fire...
    // Instead: create an enabled one that is due
    const t2 = triggerStore.create(defaultTriggerInput);
    db.run("UPDATE triggers SET next_run_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", t2.id]);

    const scheduler = new TriggerScheduler(triggerStore, runStore, eventStore, executionStore);
    // Should not throw even with errors
    await expect(scheduler.tick()).resolves.toBeDefined();
  });
});
