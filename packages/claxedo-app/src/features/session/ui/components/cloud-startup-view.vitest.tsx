import { describe, expect, test } from "vitest"
import {
  CLOUD_STARTUP_PIPELINE,
  USER_HOSTED_STARTUP_PIPELINE,
  startupPipeline,
  acquiringStepLabel,
  cleanCloudError,
  cloudStep,
  cloudSummary,
  cloudTotalElapsed,
} from "./cloud-startup-view"

describe("cloud startup helpers", () => {
  test("defines the expected startup pipeline labels", () => {
    expect(CLOUD_STARTUP_PIPELINE.map((step) => step.label)).toEqual([
      "Acquiring sandbox",
      "Cloning repository",
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
    expect(cloudSummary("ready", false)).toBe("Runtime is ready. Preparing the session.")
    expect(cloudSummary("syncing_workspace", false)).toBe("Runtime is ready. Syncing the workspace.")
    expect(cloudSummary("loading_models", false)).toBe("Runtime is ready. Loading available models.")
    expect(cloudSummary("creating_session", false)).toBe("Runtime is ready. Creating the session.")
    expect(cloudSummary("opening_session", false)).toBe("Session is ready. Opening it now.")
    expect(cloudSummary("sending_prompt", false)).toBe("Sending the first message.")
    expect(cloudSummary("error", true)).toBe("Workspace startup failed. Review the log below.")
  })
})

describe("cloudStep", () => {
  test("normalizes known provision steps", () => {
    expect(cloudStep("starting_runtime")).toBe("Starting runtime")
    expect(cloudStep("ready")).toBe("Runtime ready")
    expect(cloudStep("sending_prompt")).toBe("Sending first message")
  })
})

describe("acquiringStepLabel", () => {
  test("boot-mode phases relabel the first pipeline row instead of adding rows", () => {
    // restore/resume replace a fresh acquire — the "Acquiring sandbox" row is
    // the one whose label must change; no phase is a pipeline key of its own.
    expect(acquiringStepLabel("restoring_snapshot")).toBe("Restoring workspace from snapshot")
    expect(acquiringStepLabel("resuming_sandbox")).toBe("Resuming sandbox")
    expect(CLOUD_STARTUP_PIPELINE.map((s) => s.key)).not.toContain("restoring_snapshot")
    expect(CLOUD_STARTUP_PIPELINE.map((s) => s.key)).not.toContain("resuming_sandbox")
  })

  test("every other status keeps the default row label", () => {
    expect(acquiringStepLabel("acquiring_sandbox")).toBeUndefined()
    expect(acquiringStepLabel("cloning")).toBeUndefined()
    expect(acquiringStepLabel(undefined)).toBeUndefined()
    expect(acquiringStepLabel(null)).toBeUndefined()
  })
})

describe("user-hosted startup", () => {
  test("uses a relay-connecting pipeline, NOT the cloud sandbox-acquisition steps", () => {
    expect(USER_HOSTED_STARTUP_PIPELINE.map((step) => step.label)).toEqual([
      "Connecting to workspace",
      "Establishing relay tunnel",
      "Checking runtime health",
    ])
    // It must not show the cloud-only steps.
    const labels = USER_HOSTED_STARTUP_PIPELINE.map((s) => s.label)
    expect(labels).not.toContain("Acquiring sandbox")
    expect(labels).not.toContain("Cloning repository")
  })

  test("startupPipeline branches on variant (cloud unchanged)", () => {
    expect(startupPipeline("cloud")).toBe(CLOUD_STARTUP_PIPELINE)
    expect(startupPipeline("user-hosted")).toBe(USER_HOSTED_STARTUP_PIPELINE)
  })

  test("normalizes user-hosted connecting steps", () => {
    expect(cloudStep("connecting_workspace")).toBe("Connecting to workspace")
    expect(cloudStep("establishing_relay")).toBe("Establishing relay tunnel")
    expect(cloudStep("checking_health")).toBe("Checking runtime health")
  })

  test("user-hosted summaries describe connecting/offline, not sandbox startup", () => {
    expect(cloudSummary(undefined, false, "user-hosted")).toBe(
      "Connecting to your workspace before the composer unlocks.",
    )
    expect(cloudSummary("error", true, "user-hosted")).toBe(
      "Could not connect to the workspace. Review the details below.",
    )
    // Cloud variant stays byte-identical.
    expect(cloudSummary(undefined, false)).toBe("Checking runtime before the composer unlocks.")
    expect(cloudSummary("error", true)).toBe("Workspace startup failed. Review the log below.")
  })
})
