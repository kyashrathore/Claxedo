/**
 * The model picker's Connect-provider hand-off, per harness.
 *
 * `ModelSelectorPopover` carries a `connectHarness` prop that it forwards to
 * `DialogSelectProvider`. That prop IS the inheritance seam: whatever it holds
 * decides which catalog the user sees when they press `+` inside a session's
 * model picker. Nothing pinned it, and the composer's harness selector is the
 * only caller that sets it.
 *
 * The catalog CONTENT contract lives in
 * `src/app/dialogs/harness-provider-contract.vitest.tsx`; this file pins the
 * routing that decides which of those catalogs is asked for.
 */
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const selectProviderProps: Array<{ harness?: string }> = []
const shown: Array<() => unknown> = []

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (content: () => unknown) => {
      shown.push(content)
      content()
    },
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
  loadSelectProviderDialog: async () => ({
    // Records what the picker handed down instead of rendering the real dialog:
    // the real one is covered by the catalog-content contract next door.
    DialogSelectProvider: (props: { harness?: string }) => {
      selectProviderProps.push({ harness: props.harness })
      return null
    },
  }),
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

/** Opens the popover and clicks its Connect-provider action. */
async function openConnect(container: HTMLElement) {
  fireEvent.click(container.querySelector<HTMLElement>("[data-slot=model-trigger]")!)
  const connect = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('[aria-label="command.provider.connect"]')
    expect(node).toBeTruthy()
    return node!
  })
  fireEvent.click(connect)
  await waitFor(() => expect(selectProviderProps.length).toBe(1))
}

beforeEach(() => {
  selectProviderProps.length = 0
  shown.length = 0
})

afterEach(() => cleanup())

describe("the model picker's Connect action inherits the session's harness", () => {
  test("a pi session's picker opens the pi catalog", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()} actions connectHarness="pi">
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    await openConnect(container)
    expect(selectProviderProps[0]!.harness).toBe("pi")
  })

  // An opencode session has no harness binding to inherit: its picker must open
  // the FULL models.dev catalog, which is what an absent `harness` requests.
  test("a picker with no connectHarness opens the full catalog", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()} actions>
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    await openConnect(container)
    expect(selectProviderProps[0]!.harness).toBeUndefined()
  })

  // Regression pin for the bug this matrix was built to catch: a session whose
  // harness is NOT pi must never be handed pi's three-provider catalog.
  test("a claude-sdk session's picker does not open the pi catalog", async () => {
    const { container } = render(() => (
      <ModelSelectorPopover model={pickerState()} actions connectHarness="claude-sdk">
        <span data-slot="model-trigger">model</span>
      </ModelSelectorPopover>
    ))

    await openConnect(container)
    expect(selectProviderProps[0]!.harness).toBe("claude-sdk")
    expect(selectProviderProps[0]!.harness).not.toBe("pi")
  })
})
