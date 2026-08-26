/**
 * The model picker's lazy-catalog contract.
 *
 * PRODUCT DECISION (provider catalog as an index): boot fetches only the
 * provider INDEX — one default model per connected provider — and the FULL
 * model set is fetched when a picker is actually opened. That makes two
 * properties load-bearing, and this file pins both:
 *
 *   1. Rendering the closed picker performs NO hydration — boot must not pay
 *      for the full catalog.
 *   2. OPENING the picker hydrates — a picker that opened defaults-only and
 *      stayed that way is the failure mode the decision forbids.
 *
 * `PickerState.hydrate` is optional: harness-row pickers have complete lists
 * and never set it, so the absent case must be a no-op, not a crash.
 */
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: () => undefined,
    close: () => undefined,
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: () => "en" }),
}))

vi.mock("@/platform/telemetry/analytics", () => ({
  capture: () => undefined,
  identityProps: () => ({}),
}))

vi.mock("@/features/session/app-ports", () => ({
  loadManageModelsDialog: async () => ({ DialogManageModels: () => null }),
  loadSelectProviderDialog: async () => ({ DialogSelectProvider: () => null }),
}))

const { ModelSelectorPopover } = await import("./select-model")

const pickerState = (hydrate?: () => void) => ({
  list: () => [
    { id: "model-a", name: "Model A", provider: { id: "anthropic", name: "Anthropic" } },
  ],
  current: () => undefined,
  visible: () => true,
  set: () => undefined,
  ...(hydrate ? { hydrate } : {}),
})

const open = (container: HTMLElement) =>
  fireEvent.click(container.querySelector<HTMLElement>("[data-slot=model-trigger]")!)

afterEach(() => cleanup())

describe("the model picker hydrates the full catalog on open, not at boot", () => {
  test("rendering the closed picker does not hydrate", () => {
    const hydrate = vi.fn()
    render(() => (
      <ModelSelectorPopover model={pickerState(hydrate)}>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    expect(hydrate).not.toHaveBeenCalled()
  })

  test("opening the picker hydrates the catalog", async () => {
    const hydrate = vi.fn()
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState(hydrate)}>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    open(container)
    await waitFor(() => expect(hydrate).toHaveBeenCalled())
  })

  test("a picker without a hydrate seam still opens", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()}>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    open(container)
    await waitFor(() => {
      expect(document.querySelector("[data-component=list]") ?? document.querySelector("input")).toBeTruthy()
    })
  })
})
