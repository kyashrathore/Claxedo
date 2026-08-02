import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "../../../platform/auth/auth"
import { ControlPlaneRequestTimeoutError, controlPlaneTimeoutMs, withTimeout } from "./timeout"

describe("control-plane Convex timeouts", () => {
  test("uses bounded defaults and positive environment overrides", () => {
    expect(controlPlaneTimeoutMs("read", {})).toBe(5_000)
    expect(controlPlaneTimeoutMs("mutation", {})).toBe(10_000)
    expect(controlPlaneTimeoutMs("read", { CLAXEDO_CONVEX_READ_TIMEOUT_MS: "125" })).toBe(125)
    expect(controlPlaneTimeoutMs("mutation", { CLAXEDO_CONVEX_MUTATION_TIMEOUT_MS: "0" })).toBe(10_000)
  })

  test("maps a hung Control Plane request to a neutral typed 503 within the deadline", async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(new Promise<never>(() => undefined), 25)
      const rejection = expect(pending).rejects.toMatchObject({
        status: 503,
        code: "control_plane_request_timeout",
      })

      await vi.advanceTimersByTimeAsync(25)
      await rejection
      await expect(pending).rejects.toBeInstanceOf(ControlPlaneRequestTimeoutError)
    } finally {
      vi.useRealTimers()
    }
  })

  test("lets authority boundaries supply their public 503 error", async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(
        new Promise<never>(() => undefined),
        25,
        () => new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority request timed out"),
      )
      const rejection = expect(pending).rejects.toMatchObject({
        status: 503,
        code: "workspace_authority_unavailable",
      })

      await vi.advanceTimersByTimeAsync(25)
      await rejection
      await expect(pending).rejects.toBeInstanceOf(ControlPlaneAuthError)
    } finally {
      vi.useRealTimers()
    }
  })
})
