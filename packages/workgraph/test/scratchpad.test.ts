import { describe, it, expect, beforeEach } from "bun:test";
import { ScratchpadService } from "../src/services/scratchpad";

describe("ScratchpadService", () => {
  let scratchpad: ScratchpadService;

  beforeEach(() => {
    scratchpad = new ScratchpadService();
  });

  describe("write", () => {
    it("should create an entry and return it", () => {
      const entry = scratchpad.write("run_1", "node_1", "sp_1", "Some content");

      expect(entry.id).toBe("sp_1");
      expect(entry.runId).toBe("run_1");
      expect(entry.nodeId).toBe("node_1");
      expect(entry.content).toBe("Some content");
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.expiresAt).toBeTruthy();
    });

    it("should track total size", () => {
      scratchpad.write("run_1", "node_1", "sp_1", "Hello");
      scratchpad.write("run_1", "node_2", "sp_2", "World");

      expect(scratchpad.getTotalSize()).toBeGreaterThan(0);
      expect(scratchpad.getEntryCount()).toBe(2);
    });

    it("should throw when size limit is exceeded", () => {
      const small = new ScratchpadService({ maxSizeBytes: 10 });
      small.write("run_1", "node_1", "sp_1", "12345"); // 5 bytes

      expect(() => {
        small.write("run_1", "node_2", "sp_2", "1234567890AB"); // 12 bytes > remaining 5
      }).toThrow("Scratchpad size limit exceeded");
    });
  });

  describe("read", () => {
    it("should return entries for a given run", () => {
      scratchpad.write("run_1", "node_1", "sp_1", "Content A");
      scratchpad.write("run_2", "node_2", "sp_2", "Content B");
      scratchpad.write("run_1", "node_3", "sp_3", "Content C");

      const entries = scratchpad.read("run_1");
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.id).sort()).toEqual(["sp_1", "sp_3"]);
    });

    it("should return empty array for unknown run", () => {
      const entries = scratchpad.read("run_nonexistent");
      expect(entries).toEqual([]);
    });
  });

  describe("get", () => {
    it("should return entry by id", () => {
      scratchpad.write("run_1", "node_1", "sp_1", "Content");
      const entry = scratchpad.get("sp_1");
      expect(entry).toBeTruthy();
      expect(entry!.content).toBe("Content");
    });

    it("should return undefined for unknown id", () => {
      const entry = scratchpad.get("sp_nonexistent");
      expect(entry).toBeUndefined();
    });
  });

  describe("TTL cleanup", () => {
    it("should remove expired entries on cleanup", () => {
      // Create a scratchpad with very short TTL
      const shortTtl = new ScratchpadService({ ttlMs: 1 });
      shortTtl.write("run_1", "node_1", "sp_1", "Temporary");

      // Wait for expiry
      const waitUntil = Date.now() + 5;
      while (Date.now() < waitUntil) {
        /* busy wait */
      }

      shortTtl.cleanup();
      expect(shortTtl.getEntryCount()).toBe(0);
      expect(shortTtl.getTotalSize()).toBe(0);
    });

    it("should clean up expired entries when reading", () => {
      const shortTtl = new ScratchpadService({ ttlMs: 1 });
      shortTtl.write("run_1", "node_1", "sp_1", "Temporary");

      const waitUntil = Date.now() + 5;
      while (Date.now() < waitUntil) {
        /* busy wait */
      }

      const entries = shortTtl.read("run_1");
      expect(entries.length).toBe(0);
    });
  });

  describe("promote", () => {
    it("should promote entry to artifact", () => {
      scratchpad.write("run_1", "node_1", "sp_1", "Final version");

      const result = scratchpad.promote("sp_1");
      expect(result).toBeTruthy();
      expect(result!.entry.id).toBe("sp_1");
      expect(result!.artifact.id).toBe("artifact_sp_1");
      expect(result!.artifact.content).toBe("Final version");
      expect(result!.artifact.nodeId).toBe("node_1");
    });

    it("should remove entry from scratchpad after promotion", () => {
      scratchpad.write("run_1", "node_1", "sp_1", "Content");
      scratchpad.promote("sp_1");

      expect(scratchpad.get("sp_1")).toBeUndefined();
      expect(scratchpad.getEntryCount()).toBe(0);
    });

    it("should reduce total size after promotion", () => {
      scratchpad.write("run_1", "node_1", "sp_1", "Some content");
      const sizeBefore = scratchpad.getTotalSize();

      scratchpad.promote("sp_1");
      expect(scratchpad.getTotalSize()).toBe(sizeBefore - new TextEncoder().encode("Some content").length);
    });

    it("should return null for nonexistent entry", () => {
      const result = scratchpad.promote("sp_nonexistent");
      expect(result).toBeNull();
    });
  });
});
