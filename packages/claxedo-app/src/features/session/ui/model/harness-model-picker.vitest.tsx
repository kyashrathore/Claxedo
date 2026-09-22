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
