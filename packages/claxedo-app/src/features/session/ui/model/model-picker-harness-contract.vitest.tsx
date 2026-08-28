/**
 * The model picker's Connect action routes to Settings → Providers.
 *
 * Provider setup no longer opens harness-scoped connect dialogs from the
 * composer. Every Connect click should land on the unified Providers page.
 */
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const openSettingsProviders = vi.fn()

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

vi.mock("@/features/settings/open-settings-providers", () => ({
  openSettingsProviders,
}))

vi.mock("@/features/session/app-ports", () => ({
  loadManageModelsDialog: async () => ({ DialogManageModels: () => null }),
}))

const { ModelSelectorPopover } = await import("./select-model")

const pickerState = () => ({
  list: () => [
    { id: "model-a", name: "Model A", provider: { id: "anthropic", name: "Anthropic" } },
  ],
  current: () => undefined,
  visible: () => true,
  set: () => undefined,
})

async function openConnect(container: HTMLElement) {
  fireEvent.click(container.querySelector<HTMLElement>("[data-slot=model-trigger]")!)
  const connect = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('[aria-label="command.provider.connect"]')
    expect(node).toBeTruthy()
    return node!
  })
  fireEvent.click(connect)
  await waitFor(() => expect(openSettingsProviders).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  openSettingsProviders.mockClear()
})

afterEach(() => cleanup())

describe("the model picker's Connect action opens Settings → Providers", () => {
  test("pi sessions redirect to providers settings", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()} actions>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    await openConnect(container)
  })

  test("opencode sessions redirect to providers settings", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()} actions>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    await openConnect(container)
  })
})
