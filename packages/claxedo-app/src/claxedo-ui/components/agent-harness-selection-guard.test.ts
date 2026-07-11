import { describe, expect, test } from "bun:test"
import { shouldApplyHarnessSelection } from "./agent-harness-selection-guard"

describe("shouldApplyHarnessSelection", () => {
  test("applies an explicit menu selection to a different harness", () => {
    expect(
      shouldApplyHarnessSelection({
        next: "codex-app-server",
        current: "opencode",
        disabled: false,
        openedViaMenu: true,
      }),
    ).toBe(true)
  })

  test("rejects a stray typeahead-while-closed change (menu never opened)", () => {
    // The bug: a keyboard user tabs onto the trigger and types "check @"; the
    // Kobalte trigger's typeahead switches the harness to Codex while closed.
    expect(
      shouldApplyHarnessSelection({
        next: "codex-app-server",
        current: "opencode",
        disabled: false,
        openedViaMenu: false,
      }),
    ).toBe(false)
  })

  test("rejects when disabled even if the menu was open", () => {
    expect(
      shouldApplyHarnessSelection({
        next: "codex-app-server",
        current: "opencode",
        disabled: true,
        openedViaMenu: true,
      }),
    ).toBe(false)
  })

  test("no-ops when selecting the already-current harness", () => {
    expect(
      shouldApplyHarnessSelection({
        next: "opencode",
        current: "opencode",
        disabled: false,
        openedViaMenu: true,
      }),
    ).toBe(false)
  })

  test("rejects an empty selection", () => {
    expect(
      shouldApplyHarnessSelection({
        next: undefined,
        current: "opencode",
        disabled: false,
        openedViaMenu: true,
      }),
    ).toBe(false)
  })
})
