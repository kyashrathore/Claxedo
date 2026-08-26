import { afterEach, describe, expect, test, vi } from "vitest"
import { render, cleanup, fireEvent } from "@solidjs/testing-library"

// ---------------------------------------------------------------------------
// UI stubs — keep the component under test isolated from heavy upstream
// design-system components.
// ---------------------------------------------------------------------------

vi.mock("@opencode-ai/ui/spinner", () => ({
  Spinner: (props: any) => <div data-testid="spinner" class={props.class} />,
}))

// Partial mock: `@/ui/icons/config` re-exports `iconLibrary` from this module and
// `ClaxedoIcon` reads it, so replacing the module wholesale breaks every render
// that reaches a Claxedo glyph. Keep the real exports and override only `Icon`.
vi.mock("@opencode-ai/ui/icon", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Icon: (props: any) => <span data-testid="icon" data-name={props.name} />,
}))

import { SessionStatusStage } from "./session-status-stage"

afterEach(() => {
  cleanup()
})

describe("SessionStatusStage (rubric A2)", () => {
  test("renders nothing for undefined stage (initial busy state)", () => {
    const onCancel = vi.fn()
    const { queryByTestId } = render(() => <SessionStatusStage stage={undefined} onCancel={onCancel} />)
    expect(queryByTestId("session-status-stage")).toBeNull()
  })

  test("renders nothing for the silent redispatch stage", () => {
    const onCancel = vi.fn()
    const { queryByTestId } = render(() => <SessionStatusStage stage="redispatch" onCancel={onCancel} />)
    expect(queryByTestId("session-status-stage")).toBeNull()
  })

  test("shows a quiet 'Still working…' affordance at the pending stage", () => {
    const onCancel = vi.fn()
    const { getByTestId, queryByText } = render(() => <SessionStatusStage stage="pending" onCancel={onCancel} />)
    const surface = getByTestId("session-status-stage")
    expect(surface.dataset.stage).toBe("pending")
    expect(queryByText("Still working…")).not.toBeNull()
    // No cancel button at the pending stage — just an affordance.
    expect(surface.querySelector('[data-action="session-status-cancel"]')).toBeNull()
  })

  test("shows 'This is taking a while' + Cancel at the long stage and fires onCancel", () => {
    const onCancel = vi.fn()
    const { getByTestId, queryByText } = render(() => <SessionStatusStage stage="long" onCancel={onCancel} />)
    const surface = getByTestId("session-status-stage")
    expect(surface.dataset.stage).toBe("long")
    expect(queryByText("This is taking a while")).not.toBeNull()
    const cancel = surface.querySelector('[data-action="session-status-cancel"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test("shows 'Session is unresponsive' + Cancel at the failed stage", () => {
    const onCancel = vi.fn()
    const { getByTestId, queryByText } = render(() => <SessionStatusStage stage="failed" onCancel={onCancel} />)
    const surface = getByTestId("session-status-stage")
    expect(surface.dataset.stage).toBe("failed")
    expect(surface.getAttribute("role")).toBe("alert")
    expect(queryByText("Session is unresponsive")).not.toBeNull()
    const cancel = surface.querySelector('[data-action="session-status-cancel"]') as HTMLButtonElement
    expect(cancel).not.toBeNull()
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test("Cancel is idempotent across multiple clicks", () => {
    // The component itself just forwards each click; idempotency is the
    // responsibility of the consumer's onCancel (existing session.abort).
    // We assert here that the surface does not swallow clicks or otherwise
    // batch them, so a noop or guarded handler upstream remains safe.
    const onCancel = vi.fn()
    const { getByTestId } = render(() => <SessionStatusStage stage="failed" onCancel={onCancel} />)
    const cancel = getByTestId("session-status-stage").querySelector(
      '[data-action="session-status-cancel"]',
    ) as HTMLButtonElement
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    fireEvent.click(cancel)
    expect(onCancel).toHaveBeenCalledTimes(3)
  })

  test("hides itself once busy=false even if a stale stage is still present", () => {
    // A server-source event clears meta in the reducer, but this is the
    // belt-and-braces guard: if a consumer momentarily passes a stage but
    // marks the session as no-longer-busy, we hide rather than show stale UI.
    const { queryByTestId } = render(() => <SessionStatusStage stage="failed" busy={false} onCancel={() => {}} />)
    expect(queryByTestId("session-status-stage")).toBeNull()
  })

  describe("Retry (A2 follow-up)", () => {
    test("Retry button is hidden at the failed stage when onRetry is not provided", () => {
      const { getByTestId } = render(() => <SessionStatusStage stage="failed" onCancel={() => {}} />)
      const surface = getByTestId("session-status-stage")
      expect(surface.querySelector('[data-action="session-status-retry"]')).toBeNull()
      // Cancel still rendered — Retry is purely additive.
      expect(surface.querySelector('[data-action="session-status-cancel"]')).not.toBeNull()
    })

    test("Retry is also hidden at the long stage even when onRetry is provided", () => {
      // Retry is intentionally gated to the failed stage. At "long" the
      // user can still cancel, but re-issuing the same prompt while the
      // previous one might still complete would create a duplicate run.
      const onRetry = vi.fn()
      const { getByTestId } = render(() => <SessionStatusStage stage="long" onCancel={() => {}} onRetry={onRetry} />)
      const surface = getByTestId("session-status-stage")
      expect(surface.querySelector('[data-action="session-status-retry"]')).toBeNull()
    })

    test("Retry button renders at the failed stage when onRetry is provided", () => {
      const onRetry = vi.fn()
      const { getByTestId, queryByText } = render(() => (
        <SessionStatusStage stage="failed" onCancel={() => {}} onRetry={onRetry} />
      ))
      const surface = getByTestId("session-status-stage")
      expect(queryByText("Retry")).not.toBeNull()
      const retry = surface.querySelector('[data-action="session-status-retry"]') as HTMLButtonElement
      expect(retry).not.toBeNull()
    })

    test("clicking Retry fires onRetry", () => {
      const onRetry = vi.fn()
      const { getByTestId } = render(() => <SessionStatusStage stage="failed" onCancel={() => {}} onRetry={onRetry} />)
      const retry = getByTestId("session-status-stage").querySelector(
        '[data-action="session-status-retry"]',
      ) as HTMLButtonElement
      fireEvent.click(retry)
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    test("Cancel and Retry both render side by side at the failed stage", () => {
      const onCancel = vi.fn()
      const onRetry = vi.fn()
      const { getByTestId } = render(() => <SessionStatusStage stage="failed" onCancel={onCancel} onRetry={onRetry} />)
      const surface = getByTestId("session-status-stage")
      const cancel = surface.querySelector('[data-action="session-status-cancel"]') as HTMLButtonElement
      const retry = surface.querySelector('[data-action="session-status-retry"]') as HTMLButtonElement
      expect(cancel).not.toBeNull()
      expect(retry).not.toBeNull()
      fireEvent.click(cancel)
      fireEvent.click(retry)
      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
  })
})
