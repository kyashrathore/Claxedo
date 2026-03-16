/**
 * Unit tests for IRunStore / SqliteRunStore (via openSqliteRunStore).
 *
 * Each test uses a real in-memory SQLite DB so we exercise actual SQL.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeDb } from "../../src/db/schema";
import { openSqliteRunStore, type IRunStore } from "../../src/sdk/runs";

function makeStore(): { db: Database; store: IRunStore } {
  const db = new Database(":memory:");
  initializeDb(db);
  return { db, store: openSqliteRunStore(db) };
}

// ---------------------------------------------------------------------------
// createRun
// ---------------------------------------------------------------------------

describe("IRunStore: createRun", () => {
  it("returns a RunRow with the correct fields", () => {
    const { store } = makeStore();
    const run = store.createRun("run_test", "test goal");
    expect(run.run_id).toBe("run_test");
    expect(run.goal).toBe("test goal");
    expect(run.status).toBe("active");
  });

  it("populates created_at and updated_at as ISO strings", () => {
    const { store } = makeStore();
    const run = store.createRun("run_ts", "timing test");
    expect(typeof run.created_at).toBe("string");
    expect(typeof run.updated_at).toBe("string");
    expect(new Date(run.created_at!).getTime()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createRunWithMeta
// ---------------------------------------------------------------------------

describe("IRunStore: createRunWithMeta", () => {
  it("stores with custom status", () => {
    const { store } = makeStore();
    const run = store.createRunWithMeta("run_meta", "meta goal", "pending");
    expect(run.status).toBe("pending");
  });

  it("attaches source when provided", () => {
    const { store } = makeStore();
    store.createRunWithMeta("run_src", "src goal", "active", {
      kind: "markdown",
      title: "My doc",
      content: "# hello",
    });
    const src = store.getRunSource("run_src");
    expect(src).not.toBeNull();
    expect((src as any).title).toBe("My doc");
  });

  it("stores sourceId FK in runs_current", () => {
    const { db, store } = makeStore();
    store.createRunWithMeta("run_fk", "fk goal", "active", undefined, "slice_001");
    const row = db.query("SELECT source_id FROM runs_current WHERE run_id = ?").get("run_fk") as any;
    expect(row?.source_id).toBe("slice_001");
  });

  it("does not attach source when source arg is omitted", () => {
    const { store } = makeStore();
    store.createRunWithMeta("run_nosrc", "no src", "active");
    expect(store.getRunSource("run_nosrc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createTriggerRun
// ---------------------------------------------------------------------------

describe("IRunStore: createTriggerRun", () => {
  it("stores trigger_id and trigger_run_index in runs_current", () => {
    const { db, store } = makeStore();
    store.createTriggerRun("run_trig", "nightly build", "task", "trig_001", 2);
    const row = db.query("SELECT * FROM runs_current WHERE run_id = ?").get("run_trig") as any;
    expect(row).toBeDefined();
    expect(row.trigger_id).toBe("trig_001");
    expect(row.trigger_run_index).toBe(2);
    expect(row.runtime_type).toBe("task");
  });
});

// ---------------------------------------------------------------------------
// attachRunSource
// ---------------------------------------------------------------------------

describe("IRunStore: attachRunSource", () => {
  it("inserts a source row", () => {
    const { store } = makeStore();
    store.createRun("run_attach", "goal");
    store.attachRunSource("run_attach", { kind: "markdown", title: "Doc", content: "body" });
    const src = store.getRunSource("run_attach");
    expect((src as any)?.kind).toBe("markdown");
  });

  it("replaces an existing source row (INSERT OR REPLACE)", () => {
    const { store } = makeStore();
    store.createRun("run_replace", "goal");
    store.attachRunSource("run_replace", { kind: "markdown", title: "First", content: "v1" });
    store.attachRunSource("run_replace", { kind: "markdown", title: "Second", content: "v2" });
    const src = store.getRunSource("run_replace") as any;
    expect(src.title).toBe("Second");
  });
});

// ---------------------------------------------------------------------------
// getRun / listRuns
// ---------------------------------------------------------------------------

describe("IRunStore: getRun + listRuns", () => {
  it("getRun returns null for unknown id", () => {
    const { store } = makeStore();
    expect(store.getRun("run_nope")).toBeNull();
  });

  it("getRun returns the correct row", () => {
    const { store } = makeStore();
    store.createRun("run_get", "get goal");
    const run = store.getRun("run_get");
    expect(run?.run_id).toBe("run_get");
    expect(run?.goal).toBe("get goal");
  });

  it("listRuns returns newest first", () => {
    const { store } = makeStore();
    store.createRun("run_a", "a");
    store.createRun("run_b", "b");
    const runs = store.listRuns();
    expect(runs[0].run_id).toBe("run_b");
    expect(runs[1].run_id).toBe("run_a");
  });

  it("listRuns includes joined source columns when source attached", () => {
    const { store } = makeStore();
    store.createRun("run_joined", "joined");
    store.attachRunSource("run_joined", { kind: "markdown", title: "Title X", content: "abc" });
    const runs = store.listRuns();
    const row = runs.find((r) => r.run_id === "run_joined");
    expect(row?.source_title).toBe("Title X");
    expect(row?.source_kind).toBe("markdown");
    expect(row?.source_size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createNode / listNodes / updateNodeStatus
// ---------------------------------------------------------------------------

describe("IRunStore: nodes", () => {
  it("createNode returns row with status pending and retry_count 0", () => {
    const { store } = makeStore();
    store.createRun("run_n", "n");
    const node = store.createNode("run_n", "node_1", "developer", "code_gen", "Write code");
    expect(node.status).toBe("pending");
    expect(node.retry_count).toBe(0);
    expect(node.role).toBe("developer");
    expect(node.kind).toBe("code_gen");
  });

  it("listNodes returns empty for run with no nodes", () => {
    const { store } = makeStore();
    store.createRun("run_empty", "e");
    expect(store.listNodes("run_empty")).toHaveLength(0);
  });

  it("listNodes returns all created nodes", () => {
    const { store } = makeStore();
    store.createRun("run_multi", "m");
    store.createNode("run_multi", "node_a", "dev", "research", "A");
    store.createNode("run_multi", "node_b", "dev", "review", "B");
    expect(store.listNodes("run_multi")).toHaveLength(2);
  });

  it("updateNodeStatus returns null for unknown node", () => {
    const { store } = makeStore();
    store.createRun("run_upd", "u");
    expect(store.updateNodeStatus("run_upd", "node_nope", "completed")).toBeNull();
  });

  it("updateNodeStatus returns updated row", () => {
    const { store } = makeStore();
    store.createRun("run_upd2", "u2");
    store.createNode("run_upd2", "node_x", "dev", "research", "X");
    const updated = store.updateNodeStatus("run_upd2", "node_x", "completed");
    expect(updated?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// createEdge / listEdges
// ---------------------------------------------------------------------------

describe("IRunStore: edges", () => {
  it("createEdge stores and returns the correct row", () => {
    const { store } = makeStore();
    store.createRun("run_e", "e");
    store.createNode("run_e", "n1", "dev", "research", "N1");
    store.createNode("run_e", "n2", "dev", "review", "N2");
    const edge = store.createEdge("run_e", "edge_1", "n1", "n2", "depends_on");
    expect(edge.source_id).toBe("n1");
    expect(edge.target_id).toBe("n2");
    expect(edge.type).toBe("depends_on");
  });

  it("listEdges returns empty for run with no edges", () => {
    const { store } = makeStore();
    store.createRun("run_ne", "ne");
    expect(store.listEdges("run_ne")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getReadyNodes
// ---------------------------------------------------------------------------

describe("IRunStore: getReadyNodes", () => {
  it("returns node with no deps as ready", () => {
    const { store } = makeStore();
    store.createRun("run_ready", "r");
    store.createNode("run_ready", "n1", "dev", "research", "N1");
    expect(store.getReadyNodes("run_ready")).toContain("n1");
  });

  it("does not return node whose dependency is pending", () => {
    const { store } = makeStore();
    store.createRun("run_dep", "d");
    store.createNode("run_dep", "n1", "dev", "research", "N1");
    store.createNode("run_dep", "n2", "dev", "review", "N2");
    store.createEdge("run_dep", "e1", "n1", "n2", "depends_on");
    const ready = store.getReadyNodes("run_dep");
    expect(ready).toContain("n1");
    expect(ready).not.toContain("n2");
  });

  it("returns downstream node as ready once its dep is completed", () => {
    const { store } = makeStore();
    store.createRun("run_comp", "c");
    store.createNode("run_comp", "n1", "dev", "research", "N1");
    store.createNode("run_comp", "n2", "dev", "review", "N2");
    store.createEdge("run_comp", "e1", "n1", "n2", "depends_on");
    store.updateNodeStatus("run_comp", "n1", "completed");
    const ready = store.getReadyNodes("run_comp");
    expect(ready).toContain("n2");
    expect(ready).not.toContain("n1"); // n1 is completed, not pending
  });
});
