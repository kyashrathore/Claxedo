/**
 * Unit tests for sdk/graph-query.ts — DB-only helper functions.
 *
 * Covers functions that depend only on the raw SQLite database,
 * not on the WorkGraph singleton: touchRun, activeRunItemIds,
 * writeBlockers, and createSnapshot (with edge injection).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  touchRun,
  activeRunItemIds,
  writeBlockers,
  createSnapshot,
  runsForItem,
  attemptForItem,
  attemptsForItem,
  liveExecutions,
} from "../../src/sdk/graph-query";
import { resetWorkGraph, initWorkGraph } from "../../src/orchestrator/workgraph-bridge";
import type { WorkItem } from "../../src/model/types";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE runs_current (
      run_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      source_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE run_exec_current (
      run_id TEXT PRIMARY KEY,
      runtime_type TEXT NOT NULL,
      session_id TEXT,
      pty_id TEXT,
      directory TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE nodes_current (
      node_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      node_type TEXT NOT NULL DEFAULT 'task',
      parent_node_id TEXT,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      runtime_type TEXT NOT NULL DEFAULT 'task',
      runtime_type_reason TEXT
    );
  `);
  db.run(`
    CREATE TABLE run_node_items_current (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, work_item_id)
    );
  `);
  db.run(`
    CREATE TABLE run_blockers_current (
      run_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY (run_id, work_item_id, target_node_id)
    );
  `);
  db.run(`
    CREATE TABLE dependency_edges_current (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE scratchpad_entries (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE attempts_current (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      directory TEXT,
      worktree_path TEXT,
      session_id TEXT,
      pty_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      last_heartbeat_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL,
      logical_ts INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT NOT NULL DEFAULT 'system',
      op_id TEXT NOT NULL UNIQUE,
      prev_hash TEXT NOT NULL DEFAULT '00000000',
      hash TEXT NOT NULL DEFAULT '00000000',
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertRun(db: any, runId: string, status = "active") {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO runs_current (run_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [runId, `Goal for ${runId}`, status, now, now],
  );
}

function makeWorkItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status: "open",
    nodeType: "task",
    labels: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as WorkItem;
}

// ---------------------------------------------------------------------------
// touchRun
// ---------------------------------------------------------------------------

describe("touchRun", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
    insertRun(db, "run_1");
  });

  it("inserts a new run_exec_current row if absent", () => {
    touchRun(db, "run_1", { runtime_type: "workspace", directory: "/home/user/project" });
    const row = db.query("SELECT * FROM run_exec_current WHERE run_id = ?").get("run_1") as any;
    expect(row).not.toBeNull();
    expect(row.runtime_type).toBe("workspace");
    expect(row.directory).toBe("/home/user/project");
  });

  it("updates an existing run_exec_current row", () => {
    touchRun(db, "run_1", { runtime_type: "workspace" });
    touchRun(db, "run_1", { runtime_type: "task", session_id: "sess_new" });
    const row = db.query("SELECT * FROM run_exec_current WHERE run_id = ?").get("run_1") as any;
    expect(row.runtime_type).toBe("task");
    expect(row.session_id).toBe("sess_new");
  });

  it("defaults runtime_type to workspace on insert", () => {
    touchRun(db, "run_1", {});
    const row = db.query("SELECT * FROM run_exec_current WHERE run_id = ?").get("run_1") as any;
    expect(row.runtime_type).toBe("workspace");
  });

  it("sets session_id and pty_id when provided", () => {
    touchRun(db, "run_1", { session_id: "sess_1", pty_id: "pty_1" });
    const row = db.query("SELECT * FROM run_exec_current WHERE run_id = ?").get("run_1") as any;
    expect(row.session_id).toBe("sess_1");
    expect(row.pty_id).toBe("pty_1");
  });
});

// ---------------------------------------------------------------------------
// activeRunItemIds
// ---------------------------------------------------------------------------

describe("activeRunItemIds", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns empty set when no runs exist", () => {
    expect(activeRunItemIds(db).size).toBe(0);
  });

  it("returns work item ids from executing runs", () => {
    insertRun(db, "run_1", "executing");
    const now = new Date().toISOString();
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ["node_1", "run_1", "developer", "task", "active", 0]);
    db.run("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      ["run_1", "node_1", "item_A"]);
    const ids = activeRunItemIds(db);
    expect(ids.has("item_A")).toBe(true);
  });

  it("excludes work items from non-executing runs", () => {
    insertRun(db, "run_1", "completed");
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ["node_1", "run_1", "developer", "task", "completed", 0]);
    db.run("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      ["run_1", "node_1", "item_B"]);
    const ids = activeRunItemIds(db);
    expect(ids.has("item_B")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeBlockers
// ---------------------------------------------------------------------------

describe("writeBlockers", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
    insertRun(db, "run_1");
  });

  it("inserts blocker records for each (blocker, targetItem) pair", () => {
    const nodeItemMap = new Map<string, string>([["node_A", "item_A"], ["node_B", "item_B"]]);
    writeBlockers(db, "run_1", [
      { item_id: "external_1", title: "Blocked by external", blocked_item_ids: ["item_A"] },
    ], nodeItemMap);
    const rows = db.query("SELECT * FROM run_blockers_current WHERE run_id = ?").all("run_1") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].work_item_id).toBe("external_1");
    expect(rows[0].target_node_id).toBe("node_A");
  });

  it("replaces existing blockers on re-call", () => {
    const nodeItemMap = new Map<string, string>([["node_A", "item_A"]]);
    writeBlockers(db, "run_1", [
      { item_id: "blocker_1", title: "Old blocker", blocked_item_ids: ["item_A"] },
    ], nodeItemMap);
    writeBlockers(db, "run_1", [
      { item_id: "blocker_2", title: "New blocker", blocked_item_ids: ["item_A"] },
    ], nodeItemMap);
    const rows = db.query("SELECT * FROM run_blockers_current WHERE run_id = ?").all("run_1") as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].work_item_id).toBe("blocker_2");
  });

  it("skips entries whose target item is not in nodeItemMap", () => {
    const nodeItemMap = new Map<string, string>([["node_A", "item_A"]]);
    writeBlockers(db, "run_1", [
      { item_id: "blocker_1", title: "Blocker", blocked_item_ids: ["item_UNKNOWN"] },
    ], nodeItemMap);
    const rows = db.query("SELECT * FROM run_blockers_current WHERE run_id = ?").all("run_1") as any[];
    expect(rows).toHaveLength(0);
  });

  it("inserts nothing when blocked array is empty", () => {
    writeBlockers(db, "run_1", [], new Map());
    const rows = db.query("SELECT * FROM run_blockers_current WHERE run_id = ?").all("run_1") as any[];
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createSnapshot
// ---------------------------------------------------------------------------

describe("createSnapshot", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    resetWorkGraph();
    db = makeDb();
    insertRun(db, "run_1");
  });

  afterEach(() => {
    resetWorkGraph();
  });

  it("creates a node and node-item mapping for each work item", () => {
    const items = [makeWorkItem("item_A"), makeWorkItem("item_B")];
    const nodeItemMap = createSnapshot(db, "run_1", items);

    expect(nodeItemMap.size).toBe(2);
    const nodeIds = Array.from(nodeItemMap.keys());
    const itemIds = Array.from(nodeItemMap.values());
    expect(itemIds).toContain("item_A");
    expect(itemIds).toContain("item_B");

    // Check nodes_current rows
    const nodes = db.query("SELECT * FROM nodes_current WHERE run_id = ?").all("run_1") as any[];
    expect(nodes).toHaveLength(2);

    // Check run_node_items_current rows
    const mappings = db.query("SELECT * FROM run_node_items_current WHERE run_id = ?").all("run_1") as any[];
    expect(mappings).toHaveLength(2);

    // Verify nodeId → itemId mapping is correct
    for (const [nodeId, itemId] of nodeItemMap) {
      const mapping = mappings.find((m: any) => m.node_id === nodeId);
      expect(mapping).toBeDefined();
      expect(mapping.work_item_id).toBe(itemId);
    }
  });

  it("sets status to blocked for items in hold set", () => {
    const items = [makeWorkItem("item_A"), makeWorkItem("item_B")];
    const hold = new Set(["item_B"]);
    createSnapshot(db, "run_1", items, hold);

    const nodes = db.query("SELECT node_id, status FROM nodes_current WHERE run_id = ?").all("run_1") as any[];
    const nodeItemMap = new Map(
      (db.query("SELECT node_id, work_item_id FROM run_node_items_current WHERE run_id = ?").all("run_1") as any[])
        .map((r: any) => [r.node_id, r.work_item_id]),
    );

    for (const node of nodes) {
      const itemId = nodeItemMap.get(node.node_id);
      if (itemId === "item_B") {
        expect(node.status).toBe("blocked");
      } else {
        expect(node.status).toBe("pending");
      }
    }
  });

  it("creates scratchpad entries for each node", () => {
    const items = [makeWorkItem("item_A", { description: "Do the thing" })];
    createSnapshot(db, "run_1", items);

    const entries = db.query("SELECT * FROM scratchpad_entries WHERE run_id = ?").all("run_1") as any[];
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("Do the thing");
  });

  it("returns an empty map for empty items array", () => {
    const nodeItemMap = createSnapshot(db, "run_1", []);
    expect(nodeItemMap.size).toBe(0);
  });

  it("returns a nodeId→itemId map (not itemId→nodeId)", () => {
    const items = [makeWorkItem("item_A")];
    const nodeItemMap = createSnapshot(db, "run_1", items);

    const [nodeId] = Array.from(nodeItemMap.keys());
    // nodeId should look like a node_xxx, not item_xxx
    expect(nodeId).toMatch(/^node_/);
    expect(nodeItemMap.get(nodeId)).toBe("item_A");
  });
});

// ---------------------------------------------------------------------------
// runsForItem and attempt helpers
// ---------------------------------------------------------------------------

describe("runsForItem", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns empty array when no runs reference the item", () => {
    expect(runsForItem(db, "item_A")).toEqual([]);
  });

  it("returns run metadata for an item that has been executed", () => {
    insertRun(db, "run_1", "completed");
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ["node_1", "run_1", "developer", "task", "completed", 0]);
    db.run("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      ["run_1", "node_1", "item_A"]);

    const runs = runsForItem(db, "item_A");
    expect(runs).toHaveLength(1);
    expect(runs[0].run_id).toBe("run_1");
    expect(runs[0].node_id).toBe("node_1");
  });
});

describe("attemptForItem and attemptsForItem", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
    insertRun(db, "run_1");
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ["node_1", "run_1", "developer", "task", "active", 0]);
    db.run("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      ["run_1", "node_1", "item_A"]);
  });

  it("attemptForItem returns null when no attempts exist", () => {
    expect(attemptForItem(db, "item_A")).toBeNull();
  });

  it("attemptForItem returns the latest attempt for an item", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["att_1", "run_1", "node_1", "running", "workspace", now, now],
    );
    const attempt = attemptForItem(db, "item_A");
    expect(attempt).not.toBeNull();
    expect(attempt!.attempt_id).toBe("att_1");
    expect(attempt!.status).toBe("running");
  });

  it("attemptsForItem returns all attempts for an item", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["att_1", "run_1", "node_1", "completed", "workspace", now, now],
    );
    db.run(
      "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["att_2", "run_1", "node_1", "running", "workspace", now, now],
    );
    const attempts = attemptsForItem(db, "item_A");
    expect(attempts).toHaveLength(2);
  });
});

describe("liveExecutions", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = makeDb();
    insertRun(db, "run_1");
    db.run("INSERT INTO nodes_current (node_id, run_id, role, kind, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ["node_1", "run_1", "developer", "task", "active", 0]);
    db.run("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)",
      ["run_1", "node_1", "item_A"]);
  });

  it("returns empty array when no unfinished attempts", () => {
    const now = new Date().toISOString();
    // finished attempt
    db.run(
      "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, started_at, finished_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["att_1", "run_1", "node_1", "completed", "workspace", now, now, now],
    );
    expect(liveExecutions(db, "item_A")).toHaveLength(0);
  });

  it("returns ongoing (unfinished) executions", () => {
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["att_live", "run_1", "node_1", "running", "workspace", now, now],
    );
    const live = liveExecutions(db, "item_A");
    expect(live).toHaveLength(1);
    expect(live[0].run_id).toBe("run_1");
  });
});
