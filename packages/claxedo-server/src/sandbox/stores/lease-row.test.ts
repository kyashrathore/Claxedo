import { describe, expect, test } from "vitest"
import { toSandboxLeaseRow } from "./lease-row"
import { sandboxLeaseRowStatus, sandboxLeaseStatus } from "./lease-status"

const ready = {
  workspace_id: "ws_1",
  lease_id: "lease_1",
  home_region: "us-east",
  epoch: 3,
  status: "ready",
  driver: "docker",
  retry_count: 0,
  created_at: 10,
  updated_at: 20,
}

describe("toSandboxLeaseRow", () => {
  test("keeps recognized column values", () => {
    const row = toSandboxLeaseRow(ready)
    expect(row.status).toBe("ready")
    expect(row.driver).toBe("docker")
    expect(row.epoch).toBe(3)
    expect(row.home_region).toBe("us-east")
  })

  test("an unreadable status reads as failed, so the port reports it unavailable", () => {
    expect(toSandboxLeaseRow({ ...ready, status: "half-up" }).status).toBe("failed")
    expect(sandboxLeaseStatus(toSandboxLeaseRow({ ...ready, status: 7 }).status)).toBe("unavailable")
  })

  test("a compute class outside the four sizes reads as absent", () => {
    expect(toSandboxLeaseRow({ ...ready, compute_class: "large" }).compute_class).toBe("large")
    expect(toSandboxLeaseRow({ ...ready, compute_class: "enormous" }).compute_class).toBeNull()
  })

  test("wrong column types do not become row values", () => {
    const row = toSandboxLeaseRow({ ...ready, epoch: "3", sandbox_id: 12, retry_count: null })
    expect(row.epoch).toBe(0)
    expect(row.sandbox_id).toBeNull()
    expect(row.retry_count).toBe(0)
  })

  test("a JSON column that parses to a non-object is not handed on as one", () => {
    // `json_valid` accepts both of these, and a bare cast would type the number
    // as a checkpoint reference.
    expect(toSandboxLeaseRow({ ...ready, checkpoint: "1" }).checkpoint).toBeNull()
    expect(toSandboxLeaseRow({ ...ready, checkpoint: "null" }).checkpoint).toBeNull()
    expect(toSandboxLeaseRow({ ...ready, checkpoint: "{" }).checkpoint).toBeNull()
  })

  test("a checkpoint is kept only when every field it promises is present", () => {
    const checkpoint = {
      id: "cp_1",
      providerReference: "snap_1",
      sourceEpoch: 2,
      capturedAt: 5,
      metadata: { scope: "filesystem", sourceBehavior: "preserved", restoreMount: "new-resource" },
    }
    expect(toSandboxLeaseRow({ ...ready, checkpoint: JSON.stringify(checkpoint) }).checkpoint).toEqual(checkpoint)
    const partial = { ...checkpoint, metadata: { scope: "filesystem" } }
    expect(toSandboxLeaseRow({ ...ready, checkpoint: JSON.stringify(partial) }).checkpoint).toBeNull()
  })

  test("a restore status is kept only when its state's timestamps are there", () => {
    const failed = {
      checkpointId: "cp_1",
      sourceEpoch: 2,
      state: "failed",
      requestedAt: 1,
      failedAt: 3,
      error: "boom",
    }
    expect(toSandboxLeaseRow({ ...ready, restore: JSON.stringify(failed) }).restore).toEqual(failed)
    const { failedAt: _failedAt, ...missingTimestamp } = failed
    expect(toSandboxLeaseRow({ ...ready, restore: JSON.stringify(missingTimestamp) }).restore).toBeNull()
  })

  test("non-string label values are dropped rather than typed as strings", () => {
    const row = toSandboxLeaseRow({ ...ready, labels: JSON.stringify({ tier: "gold", count: 4 }) })
    expect(row.labels).toEqual({ tier: "gold" })
  })
})

describe("sandboxLeaseRowStatus", () => {
  const lease = { workspaceId: "ws_1", homeRegion: "us-east", driver: "docker", epoch: 1, retryCount: 0, createdAt: 0, updatedAt: 0 } as const

  test("an unavailable lease stores backoff only when a retry is scheduled", () => {
    expect(sandboxLeaseRowStatus({ ...lease, status: "unavailable" })).toBe("failed")
    expect(sandboxLeaseRowStatus({ ...lease, status: "unavailable", nextRetryAt: 5 })).toBe("backoff")
  })

  test("the states that survive a round trip come back unchanged", () => {
    for (const status of ["ready", "stopped", "destroyed"] as const) {
      expect(sandboxLeaseStatus(sandboxLeaseRowStatus({ ...lease, status }))).toBe(status)
    }
  })
})
