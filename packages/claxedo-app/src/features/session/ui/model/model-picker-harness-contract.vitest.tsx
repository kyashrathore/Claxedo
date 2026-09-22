/**
 * The model picker's Connect action routes to Settings → Providers.
 *
 * Provider setup no longer opens harness-scoped connect dialogs from the
 * composer. Every Connect click should land on the unified Providers page.
 */
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"


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
}))

const navigated = vi.fn()
// Connecting a provider is a navigation now, not a dialog; these suites mount
// the control without a router.
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigated, useLocation: () => ({ pathname: "/", search: "" }) }))

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
  await waitFor(() => expect(navigated).toHaveBeenCalledWith("/settings/models"))
}

beforeEach(() => {
  navigated.mockClear()
})

afterEach(() => cleanup())

describe("the model picker's Connect action opens Settings → Models", () => {
  test("Connect navigates to the models settings section", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()} actions>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    await openConnect(container)
  })

})
