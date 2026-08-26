import { describe, expect, test } from "vitest"
import { providerRows, quotaSummary } from "./quota-limits-view"

describe("quota limits view", () => {
  test("preserves provider-specific windows, scoped limits, resets, and plan labels", () => {
    const rows = providerRows({
      fetched_at: "2026-08-09T00:00:00Z",
      claude: {
        configured: true,
        plan_label: "Max",
        five_hour: { utilization: 25, resets_at: "2099-08-09T15:00:00Z" },
        weekly_scoped: [{ label: "Sonnet", utilization: 40, resets_at: "2099-08-10T15:00:00Z" }],
      },
      codex: {
        configured: true,
        primary_window: { used_percent: 10, reset_at: "2099-08-09T16:00:00Z" },
      },
    })

    expect(rows).toEqual([
      expect.objectContaining({
        name: "claude",
        plan: "Max",
        windows: [
          expect.objectContaining({ label: "Session", percent: 25, resetsAt: "2099-08-09T15:00:00Z" }),
          expect.objectContaining({ label: "Sonnet", percent: 40, resetsAt: "2099-08-10T15:00:00Z" }),
        ],
      }),
      expect.objectContaining({
        name: "codex",
        windows: [expect.objectContaining({ label: "Session", percent: 10, resetsAt: "2099-08-09T16:00:00Z" })],
      }),
    ])
  })

  test("keeps configured providers visible with actionable probe health", () => {
    expect(
      providerRows({
        claude: { configured: true, retry_at: "2099-08-09T15:00:00Z" },
        codex: { configured: true, auth_action_required: "reauth" },
        cursor: { configured: true, error: "Probe failed" },
        gemini: { configured: false },
      }),
    ).toEqual([
      expect.objectContaining({ name: "claude", issue: expect.stringContaining("Usage check throttled"), windows: [] }),
      expect.objectContaining({ name: "codex", issue: "Sign in again", windows: [] }),
      expect.objectContaining({ name: "cursor", issue: "Probe failed", windows: [] }),
    ])
  })

  test("summarizes provider count, most constrained window, and nearest reset", () => {
    expect(
      quotaSummary({
        claude: {
          configured: true,
          five_hour: { utilization: 75, resets_at: "2099-08-09T15:00:00Z" },
          seven_day: { utilization: 20, resets_at: "2099-08-10T15:00:00Z" },
        },
        codex: { configured: true, primary_window: { used_percent: 40, reset_at: "2099-08-11T15:00:00Z" } },
      }),
    ).toMatchObject({
      providerCount: 2,
      constrainedLabel: "Session",
      remainingPercent: 25,
      nearestReset: "2099-08-09T15:00:00Z",
    })
  })
})
