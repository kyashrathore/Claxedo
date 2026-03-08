import { describe, it, expect } from "bun:test";
import { detectConflict, resolveConflict, reconcile, type Conflict } from "../src/conflict";

describe("Conflict Detection", () => {
  it("should detect a conflict when same run_id, stream_id, stream_seq but different ids", () => {
    const localEvent = {
      id: "evt_local",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 5,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const remoteEvent = {
      id: "evt_remote",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 5,
      created_at: "2026-01-01T00:00:01.000Z",
    };

    const conflict = detectConflict(localEvent, remoteEvent);
    expect(conflict).not.toBeNull();
    expect(conflict!.eventId).toBe("evt_local");
    expect(conflict!.localValue).toBe(localEvent);
    expect(conflict!.remoteValue).toBe(remoteEvent);
    expect(conflict!.detectedAt).toBeDefined();
  });

  it("should not detect a conflict when ids are the same", () => {
    const localEvent = {
      id: "evt_same",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 5,
    };
    const remoteEvent = {
      id: "evt_same",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 5,
    };

    const conflict = detectConflict(localEvent, remoteEvent);
    expect(conflict).toBeNull();
  });

  it("should not detect a conflict when stream_seq differs", () => {
    const localEvent = {
      id: "evt_local",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 5,
    };
    const remoteEvent = {
      id: "evt_remote",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 6,
    };

    const conflict = detectConflict(localEvent, remoteEvent);
    expect(conflict).toBeNull();
  });

  it("should not detect a conflict when run_id differs", () => {
    const localEvent = {
      id: "evt_local",
      run_id: "run_1",
      stream_id: "stream_1",
      stream_seq: 5,
    };
    const remoteEvent = {
      id: "evt_remote",
      run_id: "run_2",
      stream_id: "stream_1",
      stream_seq: 5,
    };

    const conflict = detectConflict(localEvent, remoteEvent);
    expect(conflict).toBeNull();
  });
});

describe("Conflict Resolution", () => {
  const baseConflict: Conflict = {
    id: "conflict_1",
    eventId: "evt_local",
    localValue: { id: "evt_local", created_at: "2026-01-01T00:00:02.000Z", data: "local" },
    remoteValue: { id: "evt_remote", created_at: "2026-01-01T00:00:01.000Z", data: "remote" },
    detectedAt: "2026-01-01T00:00:03.000Z",
  };

  it("should resolve with lww strategy picking the later event", () => {
    const resolved = resolveConflict(baseConflict, "lww");
    expect(resolved.strategy).toBe("lww");
    expect(resolved.resolution).toBe(baseConflict.localValue); // local has later created_at
    expect(resolved.resolvedAt).toBeDefined();
  });

  it("should resolve with lww strategy picking remote when it is later", () => {
    const conflict: Conflict = {
      ...baseConflict,
      localValue: { id: "evt_local", created_at: "2026-01-01T00:00:00.000Z", data: "local" },
      remoteValue: { id: "evt_remote", created_at: "2026-01-01T00:00:05.000Z", data: "remote" },
    };
    const resolved = resolveConflict(conflict, "lww");
    expect(resolved.resolution).toBe(conflict.remoteValue);
  });

  it("should resolve with or_set strategy merging both values", () => {
    const resolved = resolveConflict(baseConflict, "or_set");
    expect(resolved.strategy).toBe("or_set");
    expect(resolved.resolution.merged).toHaveLength(2);
    expect(resolved.resolution.merged[0]).toBe(baseConflict.localValue);
    expect(resolved.resolution.merged[1]).toBe(baseConflict.remoteValue);
  });

  it("should resolve with append_merge strategy", () => {
    const resolved = resolveConflict(baseConflict, "append_merge");
    expect(resolved.strategy).toBe("append_merge");
    expect(resolved.resolution.local).toBe(baseConflict.localValue);
    expect(resolved.resolution.remote).toBe(baseConflict.remoteValue);
    expect(resolved.resolution.merged).toBe(true);
  });
});

describe("Reconcile", () => {
  it("should resolve all unresolved conflicts with the given strategy", () => {
    const conflicts: Conflict[] = [
      {
        id: "c1",
        eventId: "evt_1",
        localValue: { created_at: "2026-01-01T00:00:01.000Z" },
        remoteValue: { created_at: "2026-01-01T00:00:00.000Z" },
        detectedAt: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "c2",
        eventId: "evt_2",
        localValue: { created_at: "2026-01-01T00:00:00.000Z" },
        remoteValue: { created_at: "2026-01-01T00:00:03.000Z" },
        detectedAt: "2026-01-01T00:00:04.000Z",
      },
    ];

    const resolved = reconcile(conflicts, "lww");
    expect(resolved).toHaveLength(2);
    expect(resolved[0].resolvedAt).toBeDefined();
    expect(resolved[1].resolvedAt).toBeDefined();
    expect(resolved[0].strategy).toBe("lww");
    expect(resolved[1].strategy).toBe("lww");
  });

  it("should skip already resolved conflicts", () => {
    const conflicts: Conflict[] = [
      {
        id: "c1",
        eventId: "evt_1",
        localValue: { created_at: "2026-01-01T00:00:01.000Z" },
        remoteValue: { created_at: "2026-01-01T00:00:00.000Z" },
        detectedAt: "2026-01-01T00:00:02.000Z",
        resolvedAt: "2026-01-01T00:00:05.000Z",
        strategy: "or_set",
        resolution: { merged: [] },
      },
    ];

    const resolved = reconcile(conflicts, "lww");
    expect(resolved[0].strategy).toBe("or_set"); // unchanged — was already resolved
  });
});
