import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { CloudStartupView, cloudStep } from "./cloud-startup-view"

afterEach(() => cleanup())

describe("CloudStartupView", () => {
  test("renders a fallback row from the current status", () => {
    render(() => <CloudStartupView status="stopped" logs={[]} />)

    expect(screen.getByText("Preparing cloud workspace")).toBeTruthy()
    expect(screen.getAllByText("Starting sandbox").length).toBeGreaterThan(0)
  })

  test("renders provision logs and errors", () => {
    render(() => (
      <CloudStartupView
        status="error"
        err="runtime crashed"
        logs={[
          { step: "acquiring_sandbox", ts: 1 },
          { step: "starting_runtime", message: "booting runtime", ts: 2 },
        ]}
      />
    ))

    expect(screen.getByText("Acquiring sandbox")).toBeTruthy()
    expect(screen.getByText("booting runtime")).toBeTruthy()
    expect(screen.getByText("runtime crashed")).toBeTruthy()
  })
})

describe("cloudStep", () => {
  test("normalizes known provision steps", () => {
    expect(cloudStep("installing_runtime")).toBe("Installing runtime")
    expect(cloudStep("ready")).toBe("Runtime ready")
  })
})
