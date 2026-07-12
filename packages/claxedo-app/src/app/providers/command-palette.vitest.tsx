import { afterEach, describe, expect, test } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { formatKeybind, resolveEffectiveKeybind } from "./command-palette"

afterEach(cleanup)

// The command palette's discoverability contract (WP-C2): each command entry
// lists the ACTIVE keybinding next to it, where "active" means the user's custom
// rebind wins over the registered default and the "none" sentinel hides the
// binding. `select-file.tsx` renders exactly `formatKeybind(option.keybind)`
// where `option.keybind` is the effective binding produced by
// `resolveEffectiveKeybind`. These tests exercise that same composition.

describe("resolveEffectiveKeybind", () => {
  test("custom rebind wins over the registered default", () => {
    expect(resolveEffectiveKeybind("mod+k", "mod+p")).toBe("mod+k")
  })

  test("falls back to the registered default when there is no override", () => {
    expect(resolveEffectiveKeybind(undefined, "mod+p")).toBe("mod+p")
  })

  test("the 'none' sentinel unbinds the command (palette shows nothing)", () => {
    expect(resolveEffectiveKeybind("none", "mod+p")).toBeUndefined()
  })

  test("an empty override unbinds rather than silently reverting to the default", () => {
    expect(resolveEffectiveKeybind("", "mod+p")).toBeUndefined()
  })

  test("an undefined default with no override yields no binding", () => {
    expect(resolveEffectiveKeybind(undefined, undefined)).toBeUndefined()
  })
})

// Mirrors select-file.tsx's keybind cell: <Keybind>{formatKeybind(effective)}</Keybind>
function KeybindCell(props: { custom?: string; registeredDefault?: string }) {
  const effective = () => resolveEffectiveKeybind(props.custom, props.registeredDefault)
  return <span data-testid="keybind">{formatKeybind(effective() ?? "")}</span>
}

describe("command palette keybind cell", () => {
  test("renders the registered default binding next to a command", () => {
    const { getByTestId } = render(() => <KeybindCell registeredDefault="mod+shift+p" />)
    const text = getByTestId("keybind").textContent ?? ""
    // Platform-dependent modifier glyphs, but the command key is always shown.
    expect(text).toContain("P")
    expect(text.length).toBeGreaterThan(1)
  })

  test("renders the user's active rebind, not the default", () => {
    const { getByTestId } = render(() => <KeybindCell custom="mod+k" registeredDefault="mod+shift+p" />)
    const text = getByTestId("keybind").textContent ?? ""
    expect(text).toContain("K")
    expect(text).not.toContain("P")
  })

  test("renders an empty cell when the command is unbound", () => {
    const { getByTestId } = render(() => <KeybindCell custom="none" registeredDefault="mod+shift+p" />)
    expect(getByTestId("keybind").textContent).toBe("")
  })
})
