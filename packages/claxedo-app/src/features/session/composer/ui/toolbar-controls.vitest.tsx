import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { PromptGoalToggle } from "./toolbar-controls"

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: { children: unknown }) => <>{props.children}</>,
}))

afterEach(cleanup)

describe("PromptGoalToggle", () => {
  test("shows the active Goal mode as a clearable chip", () => {
    const onClear = vi.fn()
    const view = render(() => (
      <PromptGoalToggle
        label="Goal"
        clearLabel="Clear goal"
        onClear={onClear}
      />
    ))
    const toggle = view.getByRole("button", { name: "Clear goal" })

    expect(toggle).toHaveAttribute("aria-pressed", "true")
    expect(toggle.textContent).toBe("Goal")
    expect(toggle.querySelector('[data-icon="circle-dashed"]')).toBeTruthy()
    expect(toggle.querySelector('[data-icon="circle-x"]')).toBeTruthy()

    fireEvent.click(toggle)

    expect(onClear).toHaveBeenCalledOnce()
  })
})
