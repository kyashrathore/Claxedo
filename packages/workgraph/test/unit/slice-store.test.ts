/**
 * Unit tests for ISliceStore (openSqliteSliceStore)
 *
 * Tests the full CRUD contract: get, list, create, update.
 * Uses an in-memory SQLite database to exercise the real SQL.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openSqliteSliceStore, type ISliceStore } from "../../src/sdk/slices";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE sources_current (
      source_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_path TEXT,
      status TEXT NOT NULL,
      plan_run_id TEXT,
      last_run_id TEXT,
      error TEXT,
      provider TEXT,
      provider_connection_id TEXT,
      import_mode TEXT,
      import_query TEXT,
      mission_item_id TEXT,
      repo_ref TEXT,
      repo_label TEXT,
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
  return db;
}

function makeStore(db: InstanceType<typeof Database>): ISliceStore {
  return openSqliteSliceStore(db);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ISliceStore (openSqliteSliceStore)", () => {
  let db: InstanceType<typeof Database>;
  let store: ISliceStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
  });

  // --- create ---

  describe("create", () => {
    it("inserts and returns the slice with correct fields", () => {
      const slice = store.create("slice_1", {
        goal: "Add auth",
        kind: "spec",
        title: "Auth spec",
        content: "Implement OAuth2",
      });
      expect(slice.slice_id).toBe("slice_1");
      expect(slice.goal).toBe("Add auth");
      expect(slice.kind).toBe("spec");
      expect(slice.title).toBe("Auth spec");
      expect(slice.content).toBe("Implement OAuth2");
      expect(slice.status).toBe("draft");
      expect(slice.source_path).toBeNull();
      expect(slice.provider).toBeNull();
      expect(slice.repo_ref).toBeNull();
    });

    it("uses provided status instead of defaulting to draft", () => {
      const slice = store.create("slice_2", {
        goal: "g", kind: "spec", title: "t", content: "c", status: "active",
      });
      expect(slice.status).toBe("active");
    });

    it("stores optional fields when provided", () => {
      const slice = store.create("slice_3", {
        goal: "g",
        kind: "spec",
        title: "t",
        content: "c",
        source_path: "/path/to/spec.md",
        provider: "github",
        repo_ref: "org/repo",
        repo_label: "org/repo",
        provider_connection_id: "conn_1",
        import_mode: "issue",
        mission_item_id: "mission_1",
      });
      expect(slice.source_path).toBe("/path/to/spec.md");
      expect(slice.provider).toBe("github");
      expect(slice.repo_ref).toBe("org/repo");
      expect(slice.provider_connection_id).toBe("conn_1");
      expect(slice.import_mode).toBe("issue");
      expect(slice.mission_item_id).toBe("mission_1");
    });

    it("sets created_at and updated_at as ISO strings", () => {
      const slice = store.create("slice_4", {
        goal: "g", kind: "spec", title: "t", content: "c",
      });
      expect(() => new Date(slice.created_at)).not.toThrow();
      expect(() => new Date(slice.updated_at)).not.toThrow();
      expect(slice.created_at).toBe(slice.updated_at);
    });
  });

  // --- get ---

  describe("get", () => {
    it("returns null for a missing slice_id", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("returns the slice after create", () => {
      store.create("slice_1", { goal: "g", kind: "spec", title: "t", content: "c" });
      const slice = store.get("slice_1");
      expect(slice).not.toBeNull();
      expect(slice!.slice_id).toBe("slice_1");
    });

    it("joins run_exec_current for runtime metadata when trace_run_id is set", () => {
      const now = new Date().toISOString();
      // Create a slice with status=executing so trace_run_id = last_run_id
      db.run(
        `INSERT INTO sources_current
          (source_id, goal, kind, title, content, status, plan_run_id, last_run_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["slice_exec", "g", "spec", "t", "c", "executing", null, "run_abc", null, now, now],
      );
      db.run(
        `INSERT INTO run_exec_current (run_id, runtime_type, session_id, pty_id, directory, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ["run_abc", "workspace", "sess_1", "pty_1", "/home/user/project", now],
      );
      const slice = store.get("slice_exec");
      expect(slice).not.toBeNull();
      expect(slice!.trace_run_id).toBe("run_abc");
      expect(slice!.runtime_type).toBe("workspace");
      expect(slice!.session_id).toBe("sess_1");
      expect(slice!.directory).toBe("/home/user/project");
    });

    it("returns null runtime metadata when no exec row exists", () => {
      store.create("slice_1", { goal: "g", kind: "spec", title: "t", content: "c" });
      const slice = store.get("slice_1");
      expect(slice!.runtime_type).toBeNull();
      expect(slice!.session_id).toBeNull();
    });
  });

  // --- list ---

  describe("list", () => {
    it("returns an empty array when no slices exist", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns all slices when no filter is given", () => {
      store.create("s1", { goal: "g", kind: "spec", title: "t1", content: "c" });
      store.create("s2", { goal: "g", kind: "spec", title: "t2", content: "c" });
      expect(store.list()).toHaveLength(2);
    });

    it("filters by repo_ref when provided", () => {
      store.create("s1", { goal: "g", kind: "spec", title: "t1", content: "c", repo_ref: "org/a" });
      store.create("s2", { goal: "g", kind: "spec", title: "t2", content: "c", repo_ref: "org/b" });
      store.create("s3", { goal: "g", kind: "spec", title: "t3", content: "c" });
      expect(store.list("org/a")).toHaveLength(1);
      expect(store.list("org/a")[0].slice_id).toBe("s1");
    });

    it('returns slices with no repo_ref when "__unbound__" is passed', () => {
      store.create("s1", { goal: "g", kind: "spec", title: "t1", content: "c", repo_ref: "org/a" });
      store.create("s2", { goal: "g", kind: "spec", title: "t2", content: "c" });
      const unbound = store.list("__unbound__");
      expect(unbound).toHaveLength(1);
      expect(unbound[0].slice_id).toBe("s2");
    });
  });

  // --- update ---

  describe("update", () => {
    it("updates specific columns", () => {
      store.create("slice_1", { goal: "g", kind: "spec", title: "t", content: "c" });
      store.update("slice_1", { status: "executing", error: null });
      const slice = store.get("slice_1");
      expect(slice!.status).toBe("executing");
      expect(slice!.error).toBeNull();
    });

    it("is a no-op when changes is empty", () => {
      store.create("slice_1", { goal: "g", kind: "spec", title: "t", content: "c" });
      // Should not throw
      expect(() => store.update("slice_1", {})).not.toThrow();
    });

    it("can set a string column to null", () => {
      store.create("slice_1", { goal: "g", kind: "spec", title: "t", content: "c", provider: "github" });
      store.update("slice_1", { provider: null });
      const slice = store.get("slice_1");
      expect(slice!.provider).toBeNull();
    });
  });

  // --- trace_run_id resolution ---

  describe("trace_run_id resolution", () => {
    function createSliceWithStatus(id: string, status: string, plan_run_id: string | null, last_run_id: string | null) {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO sources_current
          (source_id, goal, kind, title, content, status, plan_run_id, last_run_id, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, "g", "spec", "t", "c", status, plan_run_id, last_run_id, null, now, now],
      );
    }

    it("uses plan_run_id when status is planning", () => {
      createSliceWithStatus("s1", "planning", "plan_1", null);
      expect(store.get("s1")!.trace_run_id).toBe("plan_1");
    });

    it("uses last_run_id when status is executing", () => {
      createSliceWithStatus("s2", "executing", "plan_1", "run_1");
      expect(store.get("s2")!.trace_run_id).toBe("run_1");
    });

    it("returns null when both run_ids are null", () => {
      createSliceWithStatus("s3", "draft", null, null);
      expect(store.get("s3")!.trace_run_id).toBeNull();
    });
  });
});
