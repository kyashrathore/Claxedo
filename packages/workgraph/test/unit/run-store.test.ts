/**
 * Unit tests for IRunStore / SqliteRunStore (via openSqliteRunStore).
 *
 * Each test uses a real in-memory SQLite DB so we exercise actual SQL.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initializeDb } from "../../src/db/schema";
import { openSqliteRunStore, type IRunStore, type RunPage } from "../../src/sdk/runs";

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

// ---------------------------------------------------------------------------
// listRuns pagination
// ---------------------------------------------------------------------------

describe("IRunStore: listRuns pagination", () => {
  it("returns all runs without opts (backward compat)", () => {
    const { store } = makeStore();
    store.createRun("run_p1", "a");
    store.createRun("run_p2", "b");
    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
    expect(Array.isArray(runs)).toBe(true);
  });

  it("returns first page with limit=1 and next_cursor set", () => {
    const { store } = makeStore();
    store.createRun("run_pg_a", "a");
    store.createRun("run_pg_b", "b");
    store.createRun("run_pg_c", "c");
    const page = store.listRuns({ limit: 1 }) as RunPage;
    expect(page.items).toHaveLength(1);
    expect(page.items[0].run_id).toBe("run_pg_c"); // newest first
    expect(typeof page.next_cursor).toBe("number");
  });

  it("next_cursor advances through pages", () => {
    const { store } = makeStore();
    store.createRun("run_pag_1", "one");
    store.createRun("run_pag_2", "two");
    store.createRun("run_pag_3", "three");

    const page1 = store.listRuns({ limit: 1 }) as RunPage;
    expect(page1.items[0].run_id).toBe("run_pag_3");
    expect(page1.next_cursor).not.toBeNull();

    const page2 = store.listRuns({ limit: 1, cursor: page1.next_cursor! }) as RunPage;
    expect(page2.items[0].run_id).toBe("run_pag_2");
    expect(page2.next_cursor).not.toBeNull();

    const page3 = store.listRuns({ limit: 1, cursor: page2.next_cursor! }) as RunPage;
    expect(page3.items[0].run_id).toBe("run_pag_1");
    expect(page3.next_cursor).toBeNull(); // last page
  });

  it("next_cursor is null when all items fit in one page", () => {
    const { store } = makeStore();
    store.createRun("run_one", "only");
    const page = store.listRuns({ limit: 10 }) as RunPage;
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getDescendants
// ---------------------------------------------------------------------------

describe("IRunStore: getDescendants", () => {
  it("returns empty nodes for a leaf node", () => {
    const { store } = makeStore();
    store.createRun("run_d", "d");
    store.createNode("run_d", "n_leaf", "dev", "task", "Leaf");
    const result = store.getDescendants("n_leaf");
    expect(result.nodes).toHaveLength(0);
    expect(result.frontier).toHaveLength(0);
  });

  it("returns children of a linear chain", () => {
    const { store } = makeStore();
    store.createRun("run_chain", "chain");
    store.createNode("run_chain", "n_root", "dev", "task", "Root");
    store.createNode("run_chain", "n_mid",  "dev", "task", "Mid");
    store.createNode("run_chain", "n_end",  "dev", "task", "End");
    store.createEdge("run_chain", "e1", "n_root", "n_mid",  "depends_on");
    store.createEdge("run_chain", "e2", "n_mid",  "n_end",  "depends_on");

    const result = store.getDescendants("n_root");
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).toContain("n_mid");
    expect(ids).toContain("n_end");
    expect(result.nodes.find((n) => n.node_id === "n_mid")?.depth).toBe(1);
    expect(result.nodes.find((n) => n.node_id === "n_end")?.depth).toBe(2);
  });

  it("handles diamond pattern (shared dependency)", () => {
    const { store } = makeStore();
    store.createRun("run_diamond", "diamond");
    store.createNode("run_diamond", "n_top", "dev", "task", "Top");
    store.createNode("run_diamond", "n_l",   "dev", "task", "Left");
    store.createNode("run_diamond", "n_r",   "dev", "task", "Right");
    store.createNode("run_diamond", "n_bot", "dev", "task", "Bottom");
    store.createEdge("run_diamond", "e1", "n_top", "n_l",   "depends_on");
    store.createEdge("run_diamond", "e2", "n_top", "n_r",   "depends_on");
    store.createEdge("run_diamond", "e3", "n_l",   "n_bot", "depends_on");
    store.createEdge("run_diamond", "e4", "n_r",   "n_bot", "depends_on");

    const result = store.getDescendants("n_top");
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).toContain("n_l");
    expect(ids).toContain("n_r");
    expect(ids).toContain("n_bot");
  });

  it("respects maxDepth and reports frontier", () => {
    const { store } = makeStore();
    store.createRun("run_depth", "depth");
    store.createNode("run_depth", "n_a", "dev", "task", "A");
    store.createNode("run_depth", "n_b", "dev", "task", "B");
    store.createNode("run_depth", "n_c", "dev", "task", "C");
    store.createEdge("run_depth", "e1", "n_a", "n_b", "depends_on");
    store.createEdge("run_depth", "e2", "n_b", "n_c", "depends_on");

    const result = store.getDescendants("n_a", 1);
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).toContain("n_b");
    expect(ids).not.toContain("n_c"); // beyond maxDepth
    expect(result.frontier).toContain("n_b"); // n_b has children at depth 1
  });
});

// ---------------------------------------------------------------------------
// getActiveDescendants
// ---------------------------------------------------------------------------

describe("IRunStore: getActiveDescendants", () => {
  it("excludes completed nodes and prunes their subtrees", () => {
    const { store } = makeStore();
    store.createRun("run_act", "act");
    store.createNode("run_act", "n_root",  "dev", "task", "Root");
    store.createNode("run_act", "n_done",  "dev", "task", "Done");
    store.createNode("run_act", "n_child", "dev", "task", "ChildOfDone");
    store.createNode("run_act", "n_pend",  "dev", "task", "Pending");
    store.createEdge("run_act", "e1", "n_root", "n_done",  "depends_on");
    store.createEdge("run_act", "e2", "n_done", "n_child", "depends_on");
    store.createEdge("run_act", "e3", "n_root", "n_pend",  "depends_on");

    store.updateNodeStatus("run_act", "n_done", "completed");

    const result = store.getActiveDescendants("n_root");
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).not.toContain("n_done");  // completed — excluded
    expect(ids).not.toContain("n_child"); // pruned (parent was completed)
    expect(ids).toContain("n_pend");      // still active
  });

  it("active sibling of a completed node is still returned", () => {
    const { store } = makeStore();
    store.createRun("run_sib", "sib");
    store.createNode("run_sib", "n_p",  "dev", "task", "Parent");
    store.createNode("run_sib", "n_d",  "dev", "task", "Done");
    store.createNode("run_sib", "n_a",  "dev", "task", "Active");
    store.createEdge("run_sib", "e1", "n_p", "n_d", "depends_on");
    store.createEdge("run_sib", "e2", "n_p", "n_a", "depends_on");

    store.updateNodeStatus("run_sib", "n_d", "completed");

    const result = store.getActiveDescendants("n_p");
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).not.toContain("n_d");
    expect(ids).toContain("n_a");
  });
});

// ---------------------------------------------------------------------------
// getAncestors
// ---------------------------------------------------------------------------

describe("IRunStore: getAncestors", () => {
  it("returns empty for a root node with no parents", () => {
    const { store } = makeStore();
    store.createRun("run_anc", "anc");
    store.createNode("run_anc", "n_root", "dev", "task", "Root");
    const result = store.getAncestors("n_root");
    expect(result.nodes).toHaveLength(0);
  });

  it("walks edges in reverse to find ancestors", () => {
    const { store } = makeStore();
    store.createRun("run_rev", "rev");
    store.createNode("run_rev", "n_a", "dev", "task", "A");
    store.createNode("run_rev", "n_b", "dev", "task", "B");
    store.createNode("run_rev", "n_c", "dev", "task", "C");
    // A → B → C (A is ancestor of C)
    store.createEdge("run_rev", "e1", "n_a", "n_b", "depends_on");
    store.createEdge("run_rev", "e2", "n_b", "n_c", "depends_on");

    const result = store.getAncestors("n_c");
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).toContain("n_b"); // depth 1
    expect(ids).toContain("n_a"); // depth 2
    expect(result.nodes.find((n) => n.node_id === "n_b")?.depth).toBe(1);
    expect(result.nodes.find((n) => n.node_id === "n_a")?.depth).toBe(2);
  });

  it("respects maxDepth", () => {
    const { store } = makeStore();
    store.createRun("run_anc_depth", "ad");
    store.createNode("run_anc_depth", "n_1", "dev", "task", "1");
    store.createNode("run_anc_depth", "n_2", "dev", "task", "2");
    store.createNode("run_anc_depth", "n_3", "dev", "task", "3");
    store.createEdge("run_anc_depth", "e1", "n_1", "n_2", "depends_on");
    store.createEdge("run_anc_depth", "e2", "n_2", "n_3", "depends_on");

    const result = store.getAncestors("n_3", 1);
    const ids = result.nodes.map((n) => n.node_id);
    expect(ids).toContain("n_2");
    expect(ids).not.toContain("n_1"); // beyond maxDepth
  });
});
