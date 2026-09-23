import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, expect, test, vi } from "vitest"
import { HarnessModelPicker } from "../../composer/ui/harness-model-picker"

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }),
}))
vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: vi.fn(), close: vi.fn() }),
}))
vi.mock("@/features/session/app-ports", () => ({
  loadManageModelsDialog: async () => ({ DialogManageModels: () => null }),
  openSettingsModels: vi.fn(),
}))
vi.mock("@/platform/telemetry/analytics", () => ({ capture: vi.fn(), identityProps: () => ({}) }))
afterEach(() => cleanup())

test("the real picker groups supplied harnesses once and selects the clicked option", async () => {
  const options = [
    { id: "claude", name: "Claude", group: "Native SDK" },
    { id: "operator", name: "Operator", group: "Connections" },
    { id: "codex", name: "Codex", group: "Native SDK" },
  ]
  const select = vi.fn()
  render(() => <HarnessModelPicker
    harness={() => options[0]}
    harnessOptions={options}
    harnessLabel={(option) => option.name}
    harnessGroup={(option) => option.group}
    harnessDisabled={() => false}
    harnessIcon={() => null}
    onHarnessSelect={select}
    model={() => ({ list: () => [], current: () => undefined, visible: () => true, set: () => {} })}
    modelLabel={() => "Select model"}
    modelLoading={() => false}
    modelDisabled={() => false}
    showManageModels={() => false}
    showEffort={() => false}
    variants={() => []}
    currentVariant={() => undefined}
    variantLabel={(value) => value}
    onVariantSelect={() => {}}
  />)
  fireEvent.click(screen.getByRole("button", { name: "Select harness, model and effort" }))
  fireEvent.click(await screen.findByRole("button", { name: /Harness.*Claude/ }))
  const panel = await waitFor(() => {
    const panel = document.querySelector('[data-slot="harness-picker-panel"]')
    expect(panel).not.toBeNull()
    return panel!
  })
  expect([...panel.children].map((element) => element.textContent?.trim())).toEqual([
    "Native SDK", "Claude", "Codex", "Connections", "Operator",
  ])
  fireEvent.click(screen.getByRole("button", { name: "Operator" }))
  expect(select).toHaveBeenCalledTimes(1)
  expect(select).toHaveBeenCalledWith(options[1])
  expect(document.querySelector('[data-slot="harness-picker-section"][data-expanded="true"]')?.textContent).toContain("Model")
})

function renderPicker(input: {
  variants: string[]
  current?: string
  fast?: { on: boolean; label: string; description?: string }
  onVariantSelect?: (value: string) => void
  onFastToggle?: (next: boolean) => void
}) {
  const harness = { id: "codex", name: "Codex", group: "Native SDK" }
  render(() => <HarnessModelPicker
    harness={() => harness}
    harnessOptions={[harness]}
    harnessLabel={(option) => option.name}
    harnessGroup={(option) => option.group}
    harnessDisabled={() => false}
    harnessIcon={() => null}
    onHarnessSelect={() => {}}
    model={() => ({ list: () => [], current: () => undefined, visible: () => true, set: () => {} })}
    modelLabel={() => "GPT-6 Astra"}
    modelLoading={() => false}
    modelDisabled={() => false}
    showManageModels={() => false}
    showEffort={() => input.variants.length > 1}
    variants={() => input.variants}
    currentVariant={() => input.current}
    variantLabel={(value) => (value === "default" ? "Default" : value)}
    onVariantSelect={input.onVariantSelect ?? (() => {})}
    fast={() => input.fast}
    onFastToggle={input.onFastToggle}
  />)
  fireEvent.click(screen.getByRole("button", { name: "Select harness, model and effort" }))
}

test("effort is a slider under the sections that steps through the model's levels without closing", async () => {
  const select = vi.fn()
  renderPicker({ variants: ["default", "low", "high", "xhigh"], current: "low", onVariantSelect: select })
  const slider = await screen.findByRole("slider", { name: "Effort" })
  expect(slider.getAttribute("aria-valuenow")).toBe("1")
  expect(slider.getAttribute("aria-valuemax")).toBe("3")
  expect(slider.getAttribute("aria-valuetext")).toBe("low")
  expect(screen.queryByRole("button", { name: /^Effort/ })).toBeNull()

  fireEvent.keyDown(slider, { key: "ArrowRight" })
  expect(select).toHaveBeenLastCalledWith("high")
  fireEvent.keyDown(slider, { key: "End" })
  expect(select).toHaveBeenLastCalledWith("xhigh")
  fireEvent.keyDown(slider, { key: "Home" })
  expect(select).toHaveBeenLastCalledWith("default")
  expect(document.querySelector('[data-component="harness-model-picker"]')).not.toBeNull()
})

test("a harness without effort keeps the row as an empty well and shows no fast toggle", async () => {
  renderPicker({ variants: [] })
  const well = await waitFor(() => {
    const element = document.querySelector('[data-slot="harness-picker-effort"]')
    expect(element).not.toBeNull()
    return element!
  })
  expect(well.getAttribute("data-supported")).toBe("false")
  expect(screen.queryByRole("slider")).toBeNull()
  expect(document.querySelector('[data-slot="harness-picker-fast"]')).toBeNull()
})

test("the fast toggle appears only with a fast tier and reports the flipped state", async () => {
  const toggle = vi.fn()
  renderPicker({
    variants: ["default", "low", "high"],
    fast: { on: false, label: "Fast", description: "2x speed, increased usage" },
    onFastToggle: toggle,
  })
  const fast = await screen.findByRole("button", { name: "Fast" })
  expect(fast.getAttribute("aria-pressed")).toBe("false")
  expect(fast.getAttribute("title")).toBe("Fast · 2x speed, increased usage")
  fireEvent.click(fast)
  expect(toggle).toHaveBeenCalledWith(true)
})

test("the Free tag is the catalog's free flag, never inferred from the provider or a missing price", async () => {
  const zen = { id: "opencode", name: "OpenCode Zen" }
  const items = [
    { id: "pickle", name: "Pickle", provider: zen, connected: true, free: true },
    { id: "flash", name: "Flash", provider: zen, connected: true },
  ]
  render(() => <HarnessModelPicker
    harness={() => ({ id: "opencode", name: "OpenCode" })}
    harnessOptions={[{ id: "opencode", name: "OpenCode" }]}
    harnessLabel={(option) => option.name}
    harnessGroup={() => "Native SDK"}
    harnessDisabled={() => false}
    harnessIcon={() => null}
    onHarnessSelect={() => {}}
    model={() => ({ list: () => items, current: () => undefined, visible: () => true, set: () => {} })}
    modelLabel={() => "Select model"}
    modelLoading={() => false}
    modelDisabled={() => false}
    showManageModels={() => false}
    showEffort={() => false}
    variants={() => []}
    currentVariant={() => undefined}
    variantLabel={(value) => value}
    onVariantSelect={() => {}}
  />)
  fireEvent.click(screen.getByRole("button", { name: "Select harness, model and effort" }))
  const name = (text: string) => screen.findByText(text, { selector: '[data-slot="list-item-name"]' })
  expect((await name("Pickle")).parentElement?.textContent).toContain("model.tag.free")
  expect((await name("Flash")).parentElement?.textContent).not.toContain("model.tag.free")
})

test("a connected provider stays Configured when its first model cannot run, and that model says it needs connecting", async () => {
  const zen = { id: "opencode", name: "OpenCode Zen" }
  const items = [
    { id: "alpha", name: "Alpha", provider: zen, connected: false },
    { id: "pickle", name: "Pickle", provider: zen, connected: true, free: true },
  ]
  render(() => <HarnessModelPicker
    harness={() => ({ id: "opencode", name: "OpenCode" })}
    harnessOptions={[{ id: "opencode", name: "OpenCode" }]}
    harnessLabel={(option) => option.name}
    harnessGroup={() => "Native SDK"}
    harnessDisabled={() => false}
    harnessIcon={() => null}
    onHarnessSelect={() => {}}
    model={() => ({ list: () => items, current: () => undefined, visible: () => true, set: () => {} })}
    modelLabel={() => "Select model"}
    modelLoading={() => false}
    modelDisabled={() => false}
    showManageModels={() => false}
    showEffort={() => false}
    variants={() => []}
    currentVariant={() => undefined}
    variantLabel={(value) => value}
    onVariantSelect={() => {}}
  />)
  fireEvent.click(screen.getByRole("button", { name: "Select harness, model and effort" }))
  const name = (text: string) => screen.findByText(text, { selector: '[data-slot="list-item-name"]' })
  expect((await name("Alpha")).parentElement?.textContent).toContain("command.provider.connect")
  expect((await name("Pickle")).parentElement?.textContent).not.toContain("command.provider.connect")
  expect(screen.getByText("OpenCode Zen").parentElement?.textContent).toContain("Configured")
})
