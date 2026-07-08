/**
 * Unit tests for IConnectionStore (openSqliteConnectionStore)
 *
 * Tests get, list, listByProvider, upsert, updateStatus, delete.
 * Uses an in-memory SQLite database to exercise the real SQL.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openSqliteConnectionStore, type IConnectionStore, type ConnectionFull } from "../../src/sdk/connections";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE provider_connections_current (
      connection_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeStore(db: InstanceType<typeof Database>): IConnectionStore {
  return openSqliteConnectionStore(db);
}

function makeConn(overrides: Partial<ConnectionFull> = {}): ConnectionFull {
  const now = new Date().toISOString();
  return {
    connection_id: "conn_1",
    provider: "github",
    name: "My GitHub",
    token: "ghp_secret",
    status: "connected",
    error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IConnectionStore (openSqliteConnectionStore)", () => {
  let db: InstanceType<typeof Database>;
  let store: IConnectionStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
  });

  // --- get ---

  describe("get", () => {
    it("returns null for a missing connection_id", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("returns a ConnectionFull (with token) after upsert", () => {
      store.upsert(makeConn());
      const conn = store.get("conn_1");
      expect(conn).not.toBeNull();
      expect(conn!.connection_id).toBe("conn_1");
      expect(conn!.token).toBe("ghp_secret");
    });

    it("does not expose token in list() results", () => {
      store.upsert(makeConn());
      const rows = store.list();
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).token).toBeUndefined();
    });
  });

  // --- list ---

  describe("list", () => {
    it("returns empty array when no connections", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns all connections without token", () => {
      store.upsert(makeConn({ connection_id: "c1", provider: "github" }));
      store.upsert(makeConn({ connection_id: "c2", provider: "linear" }));
      const rows = store.list();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect((row as any).token).toBeUndefined();
        expect(row.connection_id).toBeDefined();
      }
    });

    it("filters by provider when provided", () => {
      store.upsert(makeConn({ connection_id: "c1", provider: "github" }));
      store.upsert(makeConn({ connection_id: "c2", provider: "linear" }));
      const github = store.list("github");
      expect(github).toHaveLength(1);
      expect(github[0].connection_id).toBe("c1");
    });
  });

  // --- listByProvider ---

  describe("listByProvider", () => {
    it("returns full connections (with token) for a provider", () => {
      store.upsert(makeConn({ connection_id: "c1", provider: "github", token: "tok1" }));
      store.upsert(makeConn({ connection_id: "c2", provider: "linear", token: "tok2" }));
      const conns = store.listByProvider("github");
      expect(conns).toHaveLength(1);
      expect(conns[0].token).toBe("tok1");
    });

    it("returns empty array for unknown provider", () => {
      expect(store.listByProvider("jira")).toEqual([]);
    });
  });

  // --- upsert ---

  describe("upsert", () => {
    it("inserts a new connection", () => {
      const conn = store.upsert(makeConn());
      expect(conn.connection_id).toBe("conn_1");
      expect(conn.provider).toBe("github");
      expect(conn.name).toBe("My GitHub");
    });

    it("updates an existing connection on re-upsert", () => {
      store.upsert(makeConn({ token: "old_token" }));
      store.upsert(makeConn({ token: "new_token", name: "Updated" }));
      const conn = store.get("conn_1");
      expect(conn!.token).toBe("new_token");
      expect(conn!.name).toBe("Updated");
    });

    it("enforces one-per-provider by removing old connections for same provider", () => {
      const now = new Date().toISOString();
      store.upsert(makeConn({ connection_id: "old_conn", provider: "github", token: "old_tok", created_at: now, updated_at: now }));
      store.upsert(makeConn({ connection_id: "new_conn", provider: "github", token: "new_tok", created_at: now, updated_at: now }));
      // After upserting new_conn, old_conn should be removed
      expect(store.get("old_conn")).toBeNull();
      expect(store.get("new_conn")).not.toBeNull();
      expect(store.list("github")).toHaveLength(1);
    });
  });

  // --- updateStatus ---

  describe("updateStatus", () => {
    it("updates status and error fields", () => {
      store.upsert(makeConn({ status: "connected", error: null }));
      store.updateStatus("conn_1", "error", "Token expired");
      const conn = store.get("conn_1");
      expect(conn!.status).toBe("error");
      expect(conn!.error).toBe("Token expired");
    });

    it("clears error when set to null", () => {
      store.upsert(makeConn({ status: "error", error: "some error" }));
      store.updateStatus("conn_1", "connected", null);
      const conn = store.get("conn_1");
      expect(conn!.status).toBe("connected");
      expect(conn!.error).toBeNull();
    });
  });

  // --- delete ---

  describe("delete", () => {
    it("removes a connection", () => {
      store.upsert(makeConn());
      store.delete("conn_1");
      expect(store.get("conn_1")).toBeNull();
      expect(store.list()).toHaveLength(0);
    });

    it("is a no-op for a non-existent connection", () => {
      // Should not throw
      expect(() => store.delete("nonexistent")).not.toThrow();
    });
  });
});
