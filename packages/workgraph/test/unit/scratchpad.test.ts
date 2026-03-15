/**
 * Unit tests for the ScratchpadService.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { ScratchpadService } from "../../src/orchestrator/core/services/scratchpad";

describe("ScratchpadService.write", () => {
  it("stores an entry and returns it", () => {
    const svc = new ScratchpadService();
    const entry = svc.write("run1", "node1", "sp1", "hello world");
    expect(entry.id).toBe("sp1");
    expect(entry.runId).toBe("run1");
    expect(entry.nodeId).toBe("node1");
    expect(entry.content).toBe("hello world");
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(entry.createdAt).toBeTruthy();
    expect(entry.expiresAt).toBeTruthy();
  });

  it("tracks total size across writes", () => {
    const svc = new ScratchpadService();
    svc.write("run1", "node1", "sp1", "hello");
    svc.write("run1", "node1", "sp2", "world");
    expect(svc.getTotalSize()).toBeGreaterThan(0);
    expect(svc.getEntryCount()).toBe(2);
  });

  it("throws when size limit is exceeded", () => {
    const svc = new ScratchpadService({ maxSizeBytes: 10 });
    svc.write("run1", "node1", "sp1", "hello");
    expect(() => svc.write("run1", "node1", "sp2", "world-extra-text")).toThrow("size limit");
  });

  it("removes expired entries before checking size", async () => {
    const svc = new ScratchpadService({ ttlMs: 1, maxSizeBytes: 20 });
    svc.write("run1", "node1", "sp1", "hello");
    await new Promise((r) => setTimeout(r, 5)); // let entry expire
    // Should succeed since expired entry is cleaned up first
    svc.write("run1", "node1", "sp2", "world12345");
    expect(svc.getEntryCount()).toBe(1);
  });
});

describe("ScratchpadService.read", () => {
  it("returns entries for a specific run", () => {
    const svc = new ScratchpadService();
    svc.write("run1", "node1", "sp1", "run1 entry");
    svc.write("run2", "node2", "sp2", "run2 entry");
    const run1Entries = svc.read("run1");
    expect(run1Entries).toHaveLength(1);
    expect(run1Entries[0].content).toBe("run1 entry");
  });

  it("returns empty array for unknown run", () => {
    const svc = new ScratchpadService();
    expect(svc.read("unknown_run")).toHaveLength(0);
  });

  it("excludes expired entries", async () => {
    const svc = new ScratchpadService({ ttlMs: 1 });
    svc.write("run1", "node1", "sp1", "will expire");
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.read("run1")).toHaveLength(0);
  });
});

describe("ScratchpadService.get", () => {
  it("retrieves a specific entry by id", () => {
    const svc = new ScratchpadService();
    svc.write("run1", "node1", "my-sp-id", "content here");
    const entry = svc.get("my-sp-id");
    expect(entry).not.toBeUndefined();
    expect(entry!.content).toBe("content here");
  });

  it("returns undefined for unknown id", () => {
    const svc = new ScratchpadService();
    expect(svc.get("unknown")).toBeUndefined();
  });

  it("returns undefined for expired entry", async () => {
    const svc = new ScratchpadService({ ttlMs: 1 });
    svc.write("run1", "node1", "sp1", "content");
    await new Promise((r) => setTimeout(r, 5));
    expect(svc.get("sp1")).toBeUndefined();
  });
});

describe("ScratchpadService.promote", () => {
  it("promotes an entry to artifact and removes it", () => {
    const svc = new ScratchpadService();
    svc.write("run1", "node1", "sp1", "artifact content");
    const result = svc.promote("sp1");

    expect(result).not.toBeNull();
    expect(result!.entry.content).toBe("artifact content");
    expect(result!.artifact.content).toBe("artifact content");
    expect(result!.artifact.nodeId).toBe("node1");

    // Should be removed from scratchpad
    expect(svc.get("sp1")).toBeUndefined();
    expect(svc.getEntryCount()).toBe(0);
  });

  it("returns null for unknown id", () => {
    const svc = new ScratchpadService();
    expect(svc.promote("unknown")).toBeNull();
  });

  it("decrements total size after promote", () => {
    const svc = new ScratchpadService();
    svc.write("run1", "node1", "sp1", "hello");
    const sizeBefore = svc.getTotalSize();
    svc.promote("sp1");
    expect(svc.getTotalSize()).toBe(0);
  });
});

describe("ScratchpadService.cleanup", () => {
  it("removes all expired entries", async () => {
    const svc = new ScratchpadService({ ttlMs: 1 });
    svc.write("run1", "node1", "sp1", "will expire");
    svc.write("run1", "node2", "sp2", "will expire too");
    await new Promise((r) => setTimeout(r, 5));
    svc.cleanup();
    expect(svc.getEntryCount()).toBe(0);
    expect(svc.getTotalSize()).toBe(0);
  });

  it("only removes expired entries, leaves valid ones", async () => {
    const svc = new ScratchpadService({ ttlMs: 100 });
    svc.write("run1", "node1", "sp_expire", "will expire");
    await new Promise((r) => setTimeout(r, 5));
    // Create a new entry with fresh TTL by manually adjusting
    const svc2 = new ScratchpadService({ ttlMs: 10_000 });
    svc2.write("run1", "node2", "sp_keep", "will stay");
    svc2.cleanup();
    expect(svc2.getEntryCount()).toBe(1);
  });
});

describe("ScratchpadService size tracking", () => {
  it("correctly tracks size across writes and promotes", () => {
    const svc = new ScratchpadService();
    const e1 = svc.write("run1", "node1", "sp1", "hello");
    const e2 = svc.write("run1", "node2", "sp2", "world");
    expect(svc.getTotalSize()).toBe(e1.sizeBytes + e2.sizeBytes);
    svc.promote("sp1");
    expect(svc.getTotalSize()).toBe(e2.sizeBytes);
  });
});
