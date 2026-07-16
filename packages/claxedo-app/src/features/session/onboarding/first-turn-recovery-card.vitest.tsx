import { fireEvent, render } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { FirstTurnRecoveryCard } from "./first-turn-recovery-card"

describe("FirstTurnRecoveryCard", () => {
  test.each([
    ["credential", "Reconnect provider"],
    ["harness", "Restart harness"],
    ["model", "Switch model and retry"],
    ["workspace", "Retry workspace"],
  ] as const)("renders exactly one %s recovery action", (kind, label) => {
    const action = vi.fn()
    const view = render(() => <FirstTurnRecoveryCard kind={kind} detail="detail" onAction={action} />)
    const buttons = view.container.querySelectorAll("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toContain(label)
    fireEvent.click(buttons[0]!)
    expect(action).toHaveBeenCalledWith(kind)
  })
})
