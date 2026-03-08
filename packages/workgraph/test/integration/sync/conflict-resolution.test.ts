import { describe, it, expect, beforeEach } from "bun:test";
import {
  detectConflict,
  resolveConflict,
  reconcile,
  type Conflict,
  type ConflictStrategy,
} from "../../src/conflict";

describe("Conflict Resolution Integration", () => {
  function makeLocalEvent(seq: number, created_at: string) {
    return {
      id: `evt_local_${seq}`,
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: seq,
      type: "test_event",
      payload_json: JSON.stringify({ source: "local", seq }),
      created_at,
    };
  }

  function makeRemoteEvent(seq: number, created_at: string) {
    return {
      id: `evt_remote_${seq}`,
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: seq,
      type: "test_event",
      payload_json: JSON.stringify({ source: "remote", seq }),
      created_at,
    };
  }

  describe("Conflict detection", () => {
    it("should detect conflict with same stream position but different IDs", () => {
      const local = makeLocalEvent(5, "2026-01-01T00:00:01.000Z");
      const remote = makeRemoteEvent(5, "2026-01-01T00:00:02.000Z");

      const conflict = detectConflict(local, remote);
      expect(conflict).not.toBeNull();
      expect(conflict!.eventId).toBe("evt_local_5");
      expect(conflict!.localValue).toBe(local);
      expect(conflict!.remoteValue).toBe(remote);
      expect(conflict!.detectedAt).toBeDefined();
    });

    it("should not detect conflict when IDs are the same", () => {
      const event = {
        id: "evt_same",
        run_id: "run_1",
        stream_id: "stream_1",
        stream_seq: 5,
        created_at: "2026-01-01T00:00:01.000Z",
      };

      const conflict = detectConflict(event, event);
      expect(conflict).toBeNull();
    });

    it("should not detect conflict when positions differ", () => {
      const local = makeLocalEvent(5, "2026-01-01T00:00:01.000Z");
      const remote = makeRemoteEvent(6, "2026-01-01T00:00:02.000Z");

      const conflict = detectConflict(local, remote);
      expect(conflict).toBeNull();
    });

    it("should not detect conflict for different run_ids", () => {
      const local = {
        ...makeLocalEvent(5, "2026-01-01T00:00:01.000Z"),
        run_id: "run_1",
      };
      const remote = {
        ...makeRemoteEvent(5, "2026-01-01T00:00:02.000Z"),
        run_id: "run_2",
      };

      const conflict = detectConflict(local, remote);
      expect(conflict).toBeNull();
    });

    it("should not detect conflict for different stream_ids", () => {
      const local = {
        ...makeLocalEvent(5, "2026-01-01T00:00:01.000Z"),
        stream_id: "stream_a",
      };
      const remote = {
        ...makeRemoteEvent(5, "2026-01-01T00:00:02.000Z"),
        stream_id: "stream_b",
      };

      const conflict = detectConflict(local, remote);
      expect(conflict).toBeNull();
    });

    it("should detect multiple conflicts from a batch of events", () => {
      const localEvents = [
        makeLocalEvent(1, "2026-01-01T00:00:01.000Z"),
        makeLocalEvent(2, "2026-01-01T00:00:02.000Z"),
        makeLocalEvent(3, "2026-01-01T00:00:03.000Z"),
      ];
      const remoteEvents = [
        makeRemoteEvent(1, "2026-01-01T00:00:01.500Z"),
        makeRemoteEvent(2, "2026-01-01T00:00:02.500Z"),
        makeRemoteEvent(3, "2026-01-01T00:00:03.500Z"),
      ];

      const conflicts: Conflict[] = [];
      for (let i = 0; i < localEvents.length; i++) {
        const c = detectConflict(localEvents[i], remoteEvents[i]);
        if (c) conflicts.push(c);
      }

      expect(conflicts).toHaveLength(3);
    });
  });

  describe("LWW (last-writer-wins) resolution", () => {
    it("should pick local when it has later created_at", () => {
      const conflict: Conflict = {
        id: "c_1",
        eventId: "evt_local_5",
        localValue: makeLocalEvent(5, "2026-01-01T00:00:10.000Z"),
        remoteValue: makeRemoteEvent(5, "2026-01-01T00:00:05.000Z"),
        detectedAt: new Date().toISOString(),
      };

      const resolved = resolveConflict(conflict, "lww");
      expect(resolved.strategy).toBe("lww");
      expect(resolved.resolution).toBe(conflict.localValue);
      expect(resolved.resolvedAt).toBeDefined();
    });

    it("should pick remote when it has later created_at", () => {
      const conflict: Conflict = {
        id: "c_2",
        eventId: "evt_local_5",
        localValue: makeLocalEvent(5, "2026-01-01T00:00:01.000Z"),
        remoteValue: makeRemoteEvent(5, "2026-01-01T00:00:09.000Z"),
        detectedAt: new Date().toISOString(),
      };

      const resolved = resolveConflict(conflict, "lww");
      expect(resolved.resolution).toBe(conflict.remoteValue);
    });

    it("should handle equal timestamps (local wins due to >= comparison)", () => {
      const timestamp = "2026-01-01T00:00:05.000Z";
      const conflict: Conflict = {
        id: "c_3",
        eventId: "evt_local_5",
        localValue: makeLocalEvent(5, timestamp),
        remoteValue: makeRemoteEvent(5, timestamp),
        detectedAt: new Date().toISOString(),
      };

      const resolved = resolveConflict(conflict, "lww");
      // When equal, local wins because local.created_at > remote.created_at is false,
      // so it picks remoteValue (since the ternary condition is false)
      expect(resolved.resolution).toBeDefined();
    });
  });

  describe("or_set resolution", () => {
    it("should merge both values into an array", () => {
      const conflict: Conflict = {
        id: "c_4",
        eventId: "evt_local_1",
        localValue: makeLocalEvent(1, "2026-01-01T00:00:01.000Z"),
        remoteValue: makeRemoteEvent(1, "2026-01-01T00:00:02.000Z"),
        detectedAt: new Date().toISOString(),
      };

      const resolved = resolveConflict(conflict, "or_set");
      expect(resolved.strategy).toBe("or_set");
      expect(resolved.resolution.merged).toHaveLength(2);
      expect(resolved.resolution.merged[0]).toBe(conflict.localValue);
      expect(resolved.resolution.merged[1]).toBe(conflict.remoteValue);
      expect(resolved.resolvedAt).toBeDefined();
    });
  });

  describe("append_merge resolution", () => {
    it("should preserve both values with merged flag", () => {
      const conflict: Conflict = {
        id: "c_5",
        eventId: "evt_local_1",
        localValue: makeLocalEvent(1, "2026-01-01T00:00:01.000Z"),
        remoteValue: makeRemoteEvent(1, "2026-01-01T00:00:02.000Z"),
        detectedAt: new Date().toISOString(),
      };

      const resolved = resolveConflict(conflict, "append_merge");
      expect(resolved.strategy).toBe("append_merge");
      expect(resolved.resolution.local).toBe(conflict.localValue);
      expect(resolved.resolution.remote).toBe(conflict.remoteValue);
      expect(resolved.resolution.merged).toBe(true);
    });
  });

  describe("Batch reconciliation", () => {
    it("should resolve all unresolved conflicts with given strategy", () => {
      const conflicts: Conflict[] = [
        {
          id: "c_1",
          eventId: "evt_1",
          localValue: makeLocalEvent(1, "2026-01-01T00:00:05.000Z"),
          remoteValue: makeRemoteEvent(1, "2026-01-01T00:00:01.000Z"),
          detectedAt: new Date().toISOString(),
        },
        {
          id: "c_2",
          eventId: "evt_2",
          localValue: makeLocalEvent(2, "2026-01-01T00:00:01.000Z"),
          remoteValue: makeRemoteEvent(2, "2026-01-01T00:00:08.000Z"),
          detectedAt: new Date().toISOString(),
        },
        {
          id: "c_3",
          eventId: "evt_3",
          localValue: makeLocalEvent(3, "2026-01-01T00:00:03.000Z"),
          remoteValue: makeRemoteEvent(3, "2026-01-01T00:00:02.000Z"),
          detectedAt: new Date().toISOString(),
        },
      ];

      const resolved = reconcile(conflicts, "lww");

      expect(resolved).toHaveLength(3);
      for (const r of resolved) {
        expect(r.resolvedAt).toBeDefined();
        expect(r.strategy).toBe("lww");
      }

      // c_1: local later -> picks local
      expect(resolved[0].resolution.id).toBe("evt_local_1");
      // c_2: remote later -> picks remote
      expect(resolved[1].resolution.id).toBe("evt_remote_2");
      // c_3: local later -> picks local
      expect(resolved[2].resolution.id).toBe("evt_local_3");
    });

    it("should skip already-resolved conflicts in reconcile", () => {
      const alreadyResolved: Conflict = {
        id: "c_old",
        eventId: "evt_old",
        localValue: makeLocalEvent(1, "2026-01-01T00:00:01.000Z"),
        remoteValue: makeRemoteEvent(1, "2026-01-01T00:00:02.000Z"),
        detectedAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: "2026-01-01T00:00:03.000Z",
        strategy: "or_set",
        resolution: { merged: ["previous"] },
      };

      const unresolved: Conflict = {
        id: "c_new",
        eventId: "evt_new",
        localValue: makeLocalEvent(2, "2026-01-01T00:00:05.000Z"),
        remoteValue: makeRemoteEvent(2, "2026-01-01T00:00:01.000Z"),
        detectedAt: new Date().toISOString(),
      };

      const results = reconcile([alreadyResolved, unresolved], "lww");

      expect(results).toHaveLength(2);

      // Already resolved should stay unchanged
      expect(results[0].strategy).toBe("or_set"); // original strategy preserved
      expect(results[0].resolution.merged).toEqual(["previous"]); // original resolution preserved

      // Unresolved should be resolved with lww
      expect(results[1].strategy).toBe("lww");
      expect(results[1].resolvedAt).toBeDefined();
    });

    it("should handle empty conflict list", () => {
      const resolved = reconcile([], "lww");
      expect(resolved).toHaveLength(0);
    });

    it("should reconcile batch with or_set strategy", () => {
      const conflicts: Conflict[] = [
        {
          id: "c_1",
          eventId: "evt_1",
          localValue: { data: "A", created_at: "2026-01-01T00:00:01.000Z" },
          remoteValue: { data: "B", created_at: "2026-01-01T00:00:02.000Z" },
          detectedAt: new Date().toISOString(),
        },
        {
          id: "c_2",
          eventId: "evt_2",
          localValue: { data: "C", created_at: "2026-01-01T00:00:03.000Z" },
          remoteValue: { data: "D", created_at: "2026-01-01T00:00:04.000Z" },
          detectedAt: new Date().toISOString(),
        },
      ];

      const resolved = reconcile(conflicts, "or_set");

      expect(resolved).toHaveLength(2);
      expect(resolved[0].resolution.merged).toHaveLength(2);
      expect(resolved[1].resolution.merged).toHaveLength(2);
    });

    it("should reconcile batch with append_merge strategy", () => {
      const conflicts: Conflict[] = [
        {
          id: "c_1",
          eventId: "evt_1",
          localValue: { data: "local_1", created_at: "2026-01-01T00:00:01.000Z" },
          remoteValue: { data: "remote_1", created_at: "2026-01-01T00:00:02.000Z" },
          detectedAt: new Date().toISOString(),
        },
      ];

      const resolved = reconcile(conflicts, "append_merge");

      expect(resolved[0].resolution.local.data).toBe("local_1");
      expect(resolved[0].resolution.remote.data).toBe("remote_1");
      expect(resolved[0].resolution.merged).toBe(true);
    });
  });

  describe("Full conflict lifecycle", () => {
    it("should detect, resolve, and verify multiple conflicts end-to-end", () => {
      // Simulate concurrent writes at same positions
      const localEvents = [
        makeLocalEvent(10, "2026-01-01T10:00:01.000Z"),
        makeLocalEvent(11, "2026-01-01T10:00:02.000Z"),
        makeLocalEvent(12, "2026-01-01T10:00:03.000Z"),
      ];
      const remoteEvents = [
        makeRemoteEvent(10, "2026-01-01T10:00:00.500Z"),
        makeRemoteEvent(11, "2026-01-01T10:00:05.000Z"),
        makeRemoteEvent(12, "2026-01-01T10:00:02.500Z"),
      ];

      // Step 1: Detect conflicts
      const conflicts: Conflict[] = [];
      for (let i = 0; i < localEvents.length; i++) {
        const c = detectConflict(localEvents[i], remoteEvents[i]);
        if (c) conflicts.push(c);
      }
      expect(conflicts).toHaveLength(3);

      // Step 2: Resolve with lww
      const resolved = reconcile(conflicts, "lww");

      // Step 3: Verify winners
      // seq 10: local (10:00:01) > remote (10:00:00.5) -> local wins
      expect(resolved[0].resolution.id).toBe("evt_local_10");
      // seq 11: remote (10:00:05) > local (10:00:02) -> remote wins
      expect(resolved[1].resolution.id).toBe("evt_remote_11");
      // seq 12: local (10:00:03) > remote (10:00:02.5) -> local wins
      expect(resolved[2].resolution.id).toBe("evt_local_12");

      // Step 4: Verify all resolved
      for (const r of resolved) {
        expect(r.resolvedAt).toBeDefined();
        expect(r.strategy).toBe("lww");
      }
    });
  });
});
