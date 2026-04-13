/**
 * Tests for the lifecycle decision engine.
 *
 * These test pure logic — no mocks, no I/O, no database.
 * Input: lease state + capabilities + time
 * Output: decision
 */

import { describe, expect, test } from "vitest"
import {
  decideStart,
  decideIdle,
  decideHealthFailure,
  nextRetryAt,
  DEFAULT_CONFIG,
} from "./decision"
import type { WorkspaceLease, ProviderCapabilities } from "../authority-types"

// ── Helpers ────────────────────────────────────────────────────────────

function lease(overrides: Partial<WorkspaceLease> = {}): WorkspaceLease {
  return {
    workspace_id: "ws-test",
    lease_id: "lease-1",
    epoch: 1,
    status: "stopped",
    provider: "daytona",
    provider_object_id: null,
    provider_snapshot_id: null,
    sandbox_id: null,
    runtime_url: null,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: null,
    last_activity_at: null,
    last_health_failure_at: null,
    last_error: null,
    compute_class: null,
    accel_base_image_id: null,
    accel_prepared_image_id: null,
    accel_runtime_snapshot_id: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

const allCaps: ProviderCapabilities = {
  supports_persistent_resume: true,
  supports_filesystem_snapshot: true,
  supports_prepared_images: true,
  supports_explicit_stop: true,
  supports_health_probe: true,
}

const noCaps: ProviderCapabilities = {
  supports_persistent_resume: false,
  supports_filesystem_snapshot: false,
  supports_prepared_images: false,
  supports_explicit_stop: false,
  supports_health_probe: false,
}

const NOW = 100_000

// ── decideStart ────────────────────────────────────────────────────────

describe("decideStart", () => {
  test("skips when already ready", () => {
    const d = decideStart(lease({ status: "ready" }), allCaps, NOW)
    expect(d.action).toBe("skip")
  })

  test("marks failed when status is failed", () => {
    const d = decideStart(
      lease({ status: "failed", last_error: "out of resources" }),
      allCaps,
      NOW,
    )
    expect(d.action).toBe("mark_failed")
  })

  test("skips when already acquiring", () => {
    const d = decideStart(lease({ status: "acquiring" }), allCaps, NOW)
    expect(d.action).toBe("skip")
  })

  test("skips when already starting", () => {
    const d = decideStart(lease({ status: "starting" }), allCaps, NOW)
    expect(d.action).toBe("skip")
  })

  test("waits during backoff period", () => {
    const d = decideStart(
      lease({ status: "backoff", retry_count: 2, next_retry_at: NOW + 5000 }),
      allCaps,
      NOW,
    )
    expect(d.action).toBe("wait")
    if (d.action === "wait") {
      expect(d.until).toBe(NOW + 5000)
    }
  })

  test("proceeds after backoff elapsed", () => {
    const d = decideStart(
      lease({ status: "backoff", retry_count: 2, next_retry_at: NOW - 1 }),
      allCaps,
      NOW,
    )
    // Should fall through to start method selection
    expect(d.action).not.toBe("wait")
    expect(d.action).not.toBe("skip")
  })

  test("marks failed when max retries exceeded in backoff", () => {
    const d = decideStart(
      lease({ status: "backoff", retry_count: 10 }),
      allCaps,
      NOW,
      { ...DEFAULT_CONFIG, max_retries: 8 },
    )
    expect(d.action).toBe("mark_failed")
  })

  // Start method selection
  test("resumes when sandbox exists and provider supports resume", () => {
    const d = decideStart(
      lease({ status: "stopped", sandbox_id: "sb-1" }),
      allCaps,
      NOW,
    )
    expect(d.action).toBe("resume")
  })

  test("restores snapshot when available and provider supports it", () => {
    const d = decideStart(
      lease({
        status: "stopped",
        sandbox_id: null,
        accel_runtime_snapshot_id: "snap-1",
      }),
      { ...allCaps, supports_persistent_resume: false },
      NOW,
    )
    expect(d.action).toBe("restore_snapshot")
    if (d.action === "restore_snapshot") {
      expect(d.snapshot_id).toBe("snap-1")
    }
  })

  test("starts from prepared image when available", () => {
    const d = decideStart(
      lease({
        status: "stopped",
        sandbox_id: null,
        accel_prepared_image_id: "img-1",
      }),
      { ...noCaps, supports_prepared_images: true },
      NOW,
    )
    expect(d.action).toBe("start_prepared")
    if (d.action === "start_prepared") {
      expect(d.image_id).toBe("img-1")
    }
  })

  test("cold starts when no acceleration available", () => {
    const d = decideStart(lease({ status: "stopped" }), noCaps, NOW)
    expect(d.action).toBe("start_fresh")
  })

  test("cold starts when provider doesn't support resume even with sandbox_id", () => {
    const d = decideStart(
      lease({ status: "stopped", sandbox_id: "sb-1" }),
      noCaps,
      NOW,
    )
    expect(d.action).toBe("start_fresh")
  })

  test("prefers resume over snapshot", () => {
    const d = decideStart(
      lease({
        status: "stopped",
        sandbox_id: "sb-1",
        accel_runtime_snapshot_id: "snap-1",
      }),
      allCaps,
      NOW,
    )
    expect(d.action).toBe("resume")
  })

  test("prefers snapshot over prepared image", () => {
    const d = decideStart(
      lease({
        status: "stopped",
        sandbox_id: null,
        accel_runtime_snapshot_id: "snap-1",
        accel_prepared_image_id: "img-1",
      }),
      { ...allCaps, supports_persistent_resume: false },
      NOW,
    )
    expect(d.action).toBe("restore_snapshot")
  })
})

// ── decideIdle ─────────────────────────────────────────────────────────

describe("decideIdle", () => {
  test("skips when not ready", () => {
    const d = decideIdle(lease({ status: "stopped" }), 0, NOW)
    expect(d.action).toBe("skip")
  })

  test("skips when holds are active", () => {
    const d = decideIdle(lease({ status: "ready", last_activity_at: 0 }), 2, NOW)
    expect(d.action).toBe("skip")
  })

  test("waits when not idle long enough", () => {
    const d = decideIdle(
      lease({ status: "ready", last_activity_at: NOW - 1000 }),
      0,
      NOW,
    )
    expect(d.action).toBe("wait")
  })

  test("stops when idle threshold exceeded", () => {
    const d = decideIdle(
      lease({ status: "ready", last_activity_at: NOW - IDLE_MS - 1 }),
      0,
      NOW,
      { ...DEFAULT_CONFIG, idle_ms: IDLE_MS },
    )
    expect(d.action).toBe("stop_idle")
  })

  test("uses created_at when last_activity_at is null", () => {
    const d = decideIdle(
      lease({
        status: "ready",
        last_activity_at: null,
        created_at: NOW - IDLE_MS - 1,
      }),
      0,
      NOW,
      { ...DEFAULT_CONFIG, idle_ms: IDLE_MS },
    )
    expect(d.action).toBe("stop_idle")
  })
})

// ── decideHealthFailure ────────────────────────────────────────────────

describe("decideHealthFailure", () => {
  test("skips when not ready", () => {
    const d = decideHealthFailure(lease({ status: "stopped" }), allCaps, NOW)
    expect(d.action).toBe("skip")
  })

  test("returns wait with backoff for first failure", () => {
    const d = decideHealthFailure(
      lease({ status: "ready", retry_count: 0 }),
      allCaps,
      NOW,
    )
    expect(d.action).toBe("wait")
    if (d.action === "wait") {
      expect(d.until).toBeGreaterThan(NOW)
    }
  })

  test("marks failed when max retries exceeded", () => {
    const d = decideHealthFailure(
      lease({ status: "ready", retry_count: 8 }),
      allCaps,
      NOW,
      { ...DEFAULT_CONFIG, max_retries: 8 },
    )
    expect(d.action).toBe("mark_failed")
  })

  test("applies to unhealthy status", () => {
    const d = decideHealthFailure(
      lease({ status: "unhealthy", retry_count: 2 }),
      allCaps,
      NOW,
    )
    expect(d.action).toBe("wait")
  })
})

// ── nextRetryAt ────────────────────────────────────────────────────────

describe("nextRetryAt", () => {
  test("returns null when max retries exceeded", () => {
    expect(nextRetryAt(8, NOW, { ...DEFAULT_CONFIG, max_retries: 8 })).toBeNull()
  })

  test("returns exponential backoff", () => {
    const t0 = nextRetryAt(0, NOW)!
    const t1 = nextRetryAt(1, NOW)!
    const t2 = nextRetryAt(2, NOW)!

    expect(t0 - NOW).toBe(1000)
    expect(t1 - NOW).toBe(2000)
    expect(t2 - NOW).toBe(4000)
  })

  test("caps at backoff_max_ms", () => {
    const t = nextRetryAt(20, NOW)!
    expect(t - NOW).toBeLessThanOrEqual(DEFAULT_CONFIG.backoff_max_ms)
  })
})

const IDLE_MS = 10 * 60 * 1000
