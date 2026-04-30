import { describe, expect, test } from "vitest"
import { CLOUD_STARTUP_PIPELINE, cleanCloudError, cloudStep, cloudSummary, cloudTotalElapsed } from "./cloud-startup-view"

describe("cloud startup helpers", () => {
  test("defines the expected startup pipeline labels", () => {
    expect(CLOUD_STARTUP_PIPELINE.map((step) => step.label)).toEqual([
      "Acquiring sandbox",
      "Cloning repository",
      "Uploading runtime",
      "Starting runtime",
      "Waiting for health check",
    ])
  })

  test("computes ready state elapsed time", () => {
    expect(cloudTotalElapsed([
      { step: "acquiring_sandbox", ts: 1_000 },
      { step: "starting_runtime", ts: 3_000 },
      { step: "ready", ts: 5_000 },
    ])).toBe("4.0")
  })

  test("parses JSON error payloads and shows only the human detail", () => {
    expect(cleanCloudError(JSON.stringify({
      error: "workspace runtime unavailable",
      detail: "Invalid credentials",
      workspaceId: "ws_test",
      directory: "/tmp/ws",
    }))).toBe("workspace runtime unavailable: Invalid credentials")
  })

  test("falls back to a plain error string when it is not JSON", () => {
    expect(cleanCloudError("runtime crashed")).toBe("runtime crashed")
  })

  test("builds ready and error summaries", () => {
    expect(cloudSummary("ready", false)).toBe("Runtime is ready. Finishing workspace sync.")
    expect(cloudSummary("error", true)).toBe("Runtime startup failed. Review the logs below.")
  })
})

describe("cloudStep", () => {
  test("normalizes known provision steps", () => {
    expect(cloudStep("installing_runtime")).toBe("Installing runtime")
    expect(cloudStep("ready")).toBe("Runtime ready")
  })
})
