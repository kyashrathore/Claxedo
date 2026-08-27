import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { FirstTurnRecoveryCard } from "./first-turn-recovery-card"

describe("FirstTurnRecoveryCard", () => {
  test.each([
    ["credential", "Reconnect and resend"],
    ["harness", "Resend last prompt"],
    ["model", "Switch model and resend"],
    ["workspace", "Resend last prompt"],
    ["session", "Start a new session"],
    ["unknown", "Resend last prompt"],
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
    const button = view.getByRole("button", { name: "Resend last prompt" })

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

  test("shows the raw provider detail once when the disclosure is opened", () => {
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
    expect(disclosure).toHaveTextContent("Error details")
    expect(disclosure).not.toHaveTextContent(body)
    expect(view.container.textContent?.split(body)).toHaveLength(2)
    expect(view.container.querySelector('[data-slot="turn-error-detail-header"]')).toHaveClass("items-center")
    expect(view.getByRole("button", { name: "Copy error" })).toHaveAttribute("data-size", "small")
  })

  test("does not offer a disclosure when the detail only repeats the description", () => {
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="unknown"
        summary="The agent returned an error."
        detail="The agent returned an error."
        onAction={vi.fn()}
      />
    ))
    expect(view.container.querySelector("button[aria-expanded]")).toBeNull()
  })

  test("renders a recognized usage limit as demoted status text with no action or card", () => {
    const detail = "Claude Code returned an error result: You've reached your Fable 5 limit. Switch to another model, or manage usage credits at claude.ai/settings/usage, to continue."
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="usage_limit"
        detail={detail}
        error={{ name: "UnknownError", data: { message: detail } }}
        providerID="claude-sdk"
        onAction={vi.fn()}
      />
    ))

    expect(view.container.textContent).toContain("Claude usage limit reached")
    expect(view.container.textContent).toContain("You've reached your Fable 5 limit. Choose another model to continue.")
    expect(view.container.textContent).not.toContain("Infrastructure")
    expect(view.container.querySelectorAll("button")).toHaveLength(0)
    expect(view.queryByTestId("first-turn-recovery-card")).toBeNull()
    expect(view.getByTestId("usage-limit-status-message")).toHaveAttribute("role", "status")
    expect(view.getByTestId("usage-limit-status-message")).toHaveClass("text-text-weaker")
    expect(view.getByText("Claude usage limit reached")).toHaveClass("text-12-regular")
  })

  test("shows a recovery-action failure instead of producing an unhandled rejection", async () => {
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="model"
        onAction={async () => { throw new Error("Model update was rejected") }}
      />
    ))

    view.getByRole("button").click()

    expect(await view.findByRole("alert")).toHaveTextContent("Model update was rejected")
    expect(view.getByRole("button")).not.toBeDisabled()
  })

  test("a detail-less wire error keeps the diagnosis honest", () => {
    const view = render(() => (
      <FirstTurnRecoveryCard
        kind="unknown"
        error={{ name: "UnknownError", data: {} }}
        providerID="anthropic"
        onAction={vi.fn()}
      />
    ))
    expect(view.container.textContent).toContain("The agent returned an error before completing this turn. Resend the last prompt.")
    expect(view.container.textContent).not.toMatch(/no more detail was reported|something went wrong/i)
  })

  test("keeps recovery cards separated from the preceding timeline row", () => {
    const view = render(() => <FirstTurnRecoveryCard kind="unknown" detail="detail" onAction={vi.fn()} />)
    expect(view.getByTestId("first-turn-recovery-card")).toHaveClass("mt-2")
  })
})
