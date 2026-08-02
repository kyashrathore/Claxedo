import { cleanup, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test } from "vitest"
import { ClaxedoSessionRetry } from "./claxedo-session-retry"

describe("ClaxedoSessionRetry", () => {
  afterEach(() => cleanup())

  test("renders recovering status as a warning retry card", () => {
    const view = render(() => (
      <ClaxedoSessionRetry
        status={{
          type: "recovering",
          kind: "process_restart",
          message: "ACP process restarted after disconnect",
        }}
      />
    ))

    expect(view.container.querySelector('[data-slot="session-turn-retry"]')).not.toBeNull()
    expect(view.container.querySelector('[data-component="card"]')?.getAttribute("data-variant")).toBe("warning")
    expect(view.getByText("Recovering ACP client...")).toBeTruthy()
    expect(view.getByText("ACP process restarted after disconnect")).toBeTruthy()
  })

  test("delegates SDK retry status to upstream retry rendering", () => {
    const view = render(() => (
      <ClaxedoSessionRetry
        status={{
          type: "retry",
          message: "temporarily unavailable",
          next: Date.now() + 10_000,
          attempt: 2,
        }}
      />
    ))

    expect(view.container.querySelector('[data-slot="session-turn-retry"]')).not.toBeNull()
    expect(view.container.querySelector('[data-component="card"]')?.getAttribute("data-variant")).toBe("error")
    expect(view.getByText("temporarily unavailable")).toBeTruthy()
    expect(view.container.textContent).toContain("attempt #2")
  })

  test("renders nothing for idle status", () => {
    const view = render(() => <ClaxedoSessionRetry status={{ type: "idle" }} />)

    expect(view.container.querySelector('[data-slot="session-turn-retry"]')).toBeNull()
  })

  test("keeps upstream retry message shortening for long Gemini quota text", () => {
    const view = render(() => (
      <ClaxedoSessionRetry
        status={{
          type: "retry",
          message: "gemini exceeded your current quota " + "x".repeat(90),
          next: Date.now() + 10_000,
          attempt: 1,
        }}
      />
    ))

    expect(view.getByText("gemini is way too hot right now")).toBeTruthy()
  })
})
