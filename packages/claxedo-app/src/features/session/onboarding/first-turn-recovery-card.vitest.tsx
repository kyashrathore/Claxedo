import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { FirstTurnRecoveryCard } from "./first-turn-recovery-card"

describe("FirstTurnRecoveryCard", () => {
  test.each([
    ["credential", "Reconnect provider"],
    ["harness", "Try again"],
    ["model", "Switch model and retry"],
    ["workspace", "Retry"],
    ["session", "Start a new session"],
    ["unknown", "Try again"],
  ] as const)("renders exactly one %s recovery action", (kind, label) => {
    const action = vi.fn()
    const view = render(() => <FirstTurnRecoveryCard kind={kind} detail="detail" onAction={action} />)
    const buttons = view.container.querySelectorAll("button:not([aria-expanded])")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toContain(label)
    fireEvent.click(buttons[0]!)
    expect(action).toHaveBeenCalledWith(kind)
  })

  test("disables the action while retrying and ignores duplicate clicks", async () => {
    let complete!: () => void
    const action = vi.fn(() => new Promise<void>((resolve) => {
      complete = resolve
    }))
    const view = render(() => <FirstTurnRecoveryCard kind="unknown" detail="detail" onAction={action} />)
    const button = view.getByRole("button", { name: "Try again" })

    fireEvent.click(button)
    fireEvent.click(button)

    expect(action).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")

    complete()
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  test("names the provider and status instead of claiming no detail was reported", () => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="unknown"
        detail={`Unauthorized\n${body}`}
        error={{ name: "APIError", data: { message: "Unauthorized", statusCode: 401, responseBody: body } }}
        providerID="anthropic"
        onAction={vi.fn()}
      />
    ))

    expect(view.container.textContent).toContain("Anthropic rejected the credential (401)")
    expect(view.container.textContent).toContain("Check your API key in Settings")
    expect(view.container.textContent).not.toMatch(/no more detail was reported|something went wrong/i)
  })

  test("keeps the raw provider body collapsed until the disclosure is opened", () => {
    const body = '{"error":{"type":"authentication_error"}}'
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="unknown"
        detail={`Unauthorized\n${body}`}
        error={{ name: "APIError", data: { message: "Unauthorized", statusCode: 401, responseBody: body } }}
        providerID="anthropic"
        onAction={vi.fn()}
      />
    ))

    const disclosure = view.container.querySelector("button[aria-expanded]")
    expect(disclosure).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(disclosure!)
    expect(disclosure).toHaveAttribute("aria-expanded", "true")
    // Verbatim: the provider's own body, not a re-derived sentence.
    expect(view.container.textContent).toContain(body)
  })

  test("a detail-less wire error still renders specific transport copy, never a shrug", () => {
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="unknown"
        error={{ name: "UnknownError", data: {} }}
        providerID="anthropic"
        onAction={vi.fn()}
      />
    ))
    expect(view.container.textContent).toContain(
      "Couldn't reach Anthropic — the request never got a response. Check your connection and try again.",
    )
    expect(view.container.textContent).not.toMatch(/no more detail was reported|something went wrong/i)
  })
})
