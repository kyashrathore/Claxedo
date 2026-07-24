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
})
