/**
 * Unit tests for src/db/source.ts
 *
 * attachSource and getSource against a minimal in-memory stub.
 */

import { describe, it, expect } from "bun:test";
import { attachSource, getSource } from "../../src/db/source";
import type { RunSourceInput } from "../../src/model/types";

// ---------------------------------------------------------------------------
// Minimal DB stub
// ---------------------------------------------------------------------------

function makeDb(runExists = true) {
  const sources = new Map<string, any>();
  return {
    sources,
    query: (sql: string) => ({
      get: (...args: any[]) => {
        if (sql.includes("FROM runs_current")) {
          const runId = args[args.length - 1];
          return runExists ? { run_id: runId } : null;
        }
        if (sql.includes("FROM run_sources_current")) {
          const runId = args[args.length - 1];
          return sources.get(runId) ?? null;
        }
        return null;
      },
    }),
    run: (_sql: string, params: any[]) => {
      // INSERT OR REPLACE INTO run_sources_current (run_id, kind, title, content, source_path, created_at)
      const [runId, kind, title, content, source_path, created_at] = params;
      sources.set(runId, { run_id: runId, kind, title, content, source_path, created_at });
    },
  };
}

const input: RunSourceInput = {
  kind: "spec",
  title: "My spec",
  content: "Do the thing",
  source_path: "/path/to/spec.md",
};

// ---------------------------------------------------------------------------
// attachSource
// ---------------------------------------------------------------------------

describe("attachSource", () => {
  it("throws when run does not exist", () => {
    const db = makeDb(false);
    expect(() => attachSource(db, "no_run", input)).toThrow("Run not found: no_run");
  });

  it("returns a RunSource with the correct fields", () => {
    const db = makeDb();
    const result = attachSource(db, "run_01", input);
    expect(result.run_id).toBe("run_01");
    expect(result.kind).toBe("spec");
    expect(result.title).toBe("My spec");
    expect(result.content).toBe("Do the thing");
    expect(result.source_path).toBe("/path/to/spec.md");
    expect(typeof result.created_at).toBe("string");
  });

  it("sets source_path to null when not provided", () => {
    const db = makeDb();
    const { source_path: _, ...withoutPath } = input;
    const result = attachSource(db, "run_01", withoutPath);
    expect(result.source_path).toBeNull();
  });

  it("persists the source so getSource can retrieve it", () => {
    const db = makeDb();
    attachSource(db, "run_01", input);
    const got = getSource(db, "run_01");
    expect(got?.run_id).toBe("run_01");
    expect(got?.kind).toBe("spec");
  });
});

// ---------------------------------------------------------------------------
// getSource
// ---------------------------------------------------------------------------

describe("getSource", () => {
  it("returns null when no source is attached", () => {
    const db = makeDb();
    expect(getSource(db, "run_no_source")).toBeNull();
  });

  it("returns the source after attachSource", () => {
    const db = makeDb();
    attachSource(db, "run_01", input);
    const result = getSource(db, "run_01");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("My spec");
  });

  it("uses explicit column projection (not SELECT *)", () => {
    const seen: string[] = [];
    const db = {
      query: (sql: string) => {
        seen.push(sql);
        return { get: () => null };
      },
    };
    getSource(db, "run_01");
    expect(seen[0]).not.toContain("SELECT *");
    expect(seen[0]).toContain("SELECT run_id");
  });
});
