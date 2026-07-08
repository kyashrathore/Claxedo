import { describe, expect, test } from "vitest"
import type { SandboxLeaseRow } from "./lease-types"
import {
  DEFAULT_WORKSPACE_HOST_DECISION_CONFIG,
  decideSandboxHealthFailure,
  decideSandboxIdle,
  decideSandboxStart,
  nextSandboxRetryAt,
  type SandboxDriverPlacement,
} from "./lease-policy"

const NOW = 100_000
const IDLE_MS = 10 * 60 * 1000

const allPlacement: SandboxDriverPlacement = {
  canPauseAndRestartSameResource: true,
  canCreateFilesystemSnapshot: true,
  canStartFromPreparedImage: true,
  canStopExplicitly: true,
  hasHealthProbe: true,
}

const noPlacement: SandboxDriverPlacement = {
  canPauseAndRestartSameResource: false,
  canCreateFilesystemSnapshot: false,
  canStartFromPreparedImage: false,
  canStopExplicitly: false,
  hasHealthProbe: false,
}

function lease(overrides: Partial<SandboxLeaseRow> = {}): SandboxLeaseRow {
  return {
    workspace_id: "ws-test",
    lease_id: "lease-1",
    home_region: "us-east",
    epoch: 1,
    status: "stopped",
    driver: "daytona",
    driver_resource_id: null,
    driver_snapshot_id: null,
    sandbox_id: null,
    url: null,
    retry_count: 0,
    next_retry_at: null,
    last_heartbeat_at: null,
    last_activity_at: null,
    last_health_failure_at: null,
    last_error: null,
    compute_class: null,
    accel_base_image_id: null,
    accel_prepared_image_id: null,
    accel_snapshot_id: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  }
}

describe("sandbox lease policy", () => {
  test("skips start decisions for already ready or in-flight leases", () => {
    expect(decideSandboxStart(lease({ status: "ready" }), allPlacement, NOW)).toMatchObject({ action: "skip" })
    expect(decideSandboxStart(lease({ status: "acquiring" }), allPlacement, NOW)).toMatchObject({ action: "skip" })
    expect(decideSandboxStart(lease({ status: "starting" }), allPlacement, NOW)).toMatchObject({ action: "skip" })
  })

  test("marks failed terminal start states and retry caps", () => {
    expect(decideSandboxStart(
      lease({ status: "failed", last_error: "out of resources" }),
      allPlacement,
      NOW,
    )).toMatchObject({ action: "mark_failed" })
    expect(decideSandboxStart(
      lease({ status: "backoff", retry_count: 10 }),
      allPlacement,
      NOW,
      { ...DEFAULT_WORKSPACE_HOST_DECISION_CONFIG, maxRetries: 8 },
    )).toMatchObject({ action: "mark_failed" })
  })

  test("waits during backoff and starts once backoff elapses", () => {
    expect(decideSandboxStart(
      lease({ status: "backoff", retry_count: 2, next_retry_at: NOW + 5000 }),
      allPlacement,
      NOW,
    )).toEqual({ action: "wait", until: NOW + 5000, reason: "backoff timer not elapsed" })
    expect(decideSandboxStart(
      lease({ status: "backoff", retry_count: 2, next_retry_at: NOW - 1 }),
      noPlacement,
      NOW,
    )).toMatchObject({ action: "start_fresh" })
  })

  test("selects start method by driver placement and acceleration precedence", () => {
    expect(decideSandboxStart(
      lease({ status: "stopped", sandbox_id: "sb-1" }),
      allPlacement,
      NOW,
    )).toMatchObject({ action: "resume" })
    expect(decideSandboxStart(
      lease({ status: "stopped", sandbox_id: null, accel_snapshot_id: "snap-1" }),
      { ...allPlacement, canPauseAndRestartSameResource: false },
      NOW,
    )).toEqual({ action: "restore_snapshot", snapshot_id: "snap-1", reason: "restore snapshot snap-1" })
    expect(decideSandboxStart(
      lease({ status: "stopped", sandbox_id: null, accel_prepared_image_id: "img-1" }),
      { ...noPlacement, canStartFromPreparedImage: true },
      NOW,
    )).toEqual({ action: "start_prepared", image_id: "img-1", reason: "start from prepared image img-1" })
    expect(decideSandboxStart(
      lease({ status: "stopped", sandbox_id: "sb-1" }),
      noPlacement,
      NOW,
    )).toMatchObject({ action: "start_fresh" })
  })

  test("prefers resume over snapshot and snapshot over prepared image", () => {
    expect(decideSandboxStart(
      lease({ status: "stopped", sandbox_id: "sb-1", accel_snapshot_id: "snap-1" }),
      allPlacement,
      NOW,
    )).toMatchObject({ action: "resume" })
    expect(decideSandboxStart(
      lease({
        status: "stopped",
        accel_snapshot_id: "snap-1",
        accel_prepared_image_id: "img-1",
      }),
      { ...allPlacement, canPauseAndRestartSameResource: false },
      NOW,
    )).toMatchObject({ action: "restore_snapshot" })
  })

  test("idle policy waits, skips, or stops based on status, holds, and last activity", () => {
    expect(decideSandboxIdle(lease({ status: "stopped" }), 0, NOW)).toMatchObject({ action: "skip" })
    expect(decideSandboxIdle(lease({ status: "ready", last_activity_at: 0 }), 2, NOW)).toMatchObject({ action: "skip" })
    expect(decideSandboxIdle(
      lease({ status: "ready", last_activity_at: NOW - 1000 }),
      0,
      NOW,
    )).toMatchObject({ action: "wait" })
    expect(decideSandboxIdle(
      lease({ status: "ready", last_activity_at: NOW - IDLE_MS - 1 }),
      0,
      NOW,
      { ...DEFAULT_WORKSPACE_HOST_DECISION_CONFIG, idleMs: IDLE_MS },
    )).toMatchObject({ action: "stop_idle" })
    expect(decideSandboxIdle(
      lease({ status: "ready", last_activity_at: null, created_at: NOW - IDLE_MS - 1 }),
      0,
      NOW,
      { ...DEFAULT_WORKSPACE_HOST_DECISION_CONFIG, idleMs: IDLE_MS },
    )).toMatchObject({ action: "stop_idle" })
  })

  test("health failure policy skips inapplicable states, backs off, and caps retries", () => {
    expect(decideSandboxHealthFailure(lease({ status: "stopped" }), allPlacement, NOW)).toMatchObject({ action: "skip" })
    expect(decideSandboxHealthFailure(
      lease({ status: "ready", retry_count: 0 }),
      allPlacement,
      NOW,
    )).toMatchObject({ action: "wait", until: NOW + 1000 })
    expect(decideSandboxHealthFailure(
      lease({ status: "ready", retry_count: 8 }),
      allPlacement,
      NOW,
      { ...DEFAULT_WORKSPACE_HOST_DECISION_CONFIG, maxRetries: 8 },
    )).toMatchObject({ action: "mark_failed" })
    expect(decideSandboxHealthFailure(
      lease({ status: "unhealthy", retry_count: 2 }),
      allPlacement,
      NOW,
    )).toMatchObject({ action: "wait" })
  })

  test("retry timestamps use capped exponential backoff", () => {
    expect(nextSandboxRetryAt(8, NOW, { ...DEFAULT_WORKSPACE_HOST_DECISION_CONFIG, maxRetries: 8 })).toBeNull()
    expect(nextSandboxRetryAt(0, NOW)! - NOW).toBe(1000)
    expect(nextSandboxRetryAt(1, NOW)! - NOW).toBe(2000)
    expect(nextSandboxRetryAt(2, NOW)! - NOW).toBe(4000)
    expect(nextSandboxRetryAt(20, NOW)! - NOW).toBeLessThanOrEqual(DEFAULT_WORKSPACE_HOST_DECISION_CONFIG.backoffMaxMs)
  })
})
