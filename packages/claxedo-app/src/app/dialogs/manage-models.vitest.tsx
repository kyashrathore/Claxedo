import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"

const state = vi.hoisted(() => ({
  model: undefined as undefined | {
    list: () => unknown[]
    visible: (key: { providerID: string; modelID: string }) => boolean
    setVisibility: ReturnType<typeof vi.fn>
    hydrate: ReturnType<typeof vi.fn>
  },
}))

vi.mock("@/features/session/providers/session-selection", () => ({ useLocal: () => ({ model: state.model }) }))
vi.mock("@/app/providers/use-providers", () => ({ popularProviders: ["anthropic", "openai"] }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: vi.fn() }) }))
vi.mock("@opencode-ai/ui/dialog", () => ({ Dialog: (props: { children?: unknown }) => <div>{props.children as never}</div> }))

const navigated = vi.fn()
// Connecting a provider navigates to the settings surface now.
vi.mock("@solidjs/router", () => ({ useNavigate: () => navigated, useLocation: () => ({ pathname: "/", search: "" }) }))

import { DialogManageModels } from "./manage-models"

beforeEach(() => {
  const models = [
    { id: "opus", name: "Opus", provider: { id: "anthropic", name: "Anthropic" } },
    { id: "sonnet", name: "Sonnet", provider: { id: "anthropic", name: "Anthropic" } },
    { id: "gpt", name: "GPT", provider: { id: "openai", name: "OpenAI" } },
  ]
  const [visible, setVisible] = createSignal(new Set(["anthropic:opus", "anthropic:sonnet", "openai:gpt"]))
  state.model = {
    list: () => models,
    visible: (key) => visible().has(`${key.providerID}:${key.modelID}`),
    setVisibility: vi.fn((key: { providerID: string; modelID: string }, checked: boolean) => {
      setVisible((previous) => {
        const next = new Set(previous)
        const id = `${key.providerID}:${key.modelID}`
        if (checked) next.add(id)
        else next.delete(id)
        return next
      })
    }),
    hydrate: vi.fn(async () => undefined),
  }
})

afterEach(cleanup)

async function mount() {
  const result = render(() => <DialogManageModels />)
  await screen.findByText("Opus")
  return result
}

describe("DialogManageModels", () => {
  test("asks the pane's model owner to hydrate once when opened", async () => {
    await mount()
    expect(state.model?.hydrate).toHaveBeenCalledTimes(1)
  })

  test("selecting a model changes only that model's visibility", async () => {
    const { container } = await mount()
    const row = container.querySelector<HTMLElement>('[data-slot="list-item"][data-key="anthropic:opus"]')!
    fireEvent.click(row)
    expect(state.model?.setVisibility.mock.calls).toEqual([[{ providerID: "anthropic", modelID: "opus" }, false]])
    await waitFor(() => expect(within(row).getByRole("switch")).not.toBeChecked())
    expect(state.model?.visible({ providerID: "anthropic", modelID: "sonnet" })).toBe(true)
    expect(state.model?.visible({ providerID: "openai", modelID: "gpt" })).toBe(true)
  })

  test("the provider switch changes its models without changing another provider", async () => {
    await mount()
    fireEvent.click(screen.getByRole("switch", { name: "Anthropic" }))
    expect(state.model?.setVisibility.mock.calls).toEqual([
      [{ providerID: "anthropic", modelID: "opus" }, false],
      [{ providerID: "anthropic", modelID: "sonnet" }, false],
    ])
    expect(state.model?.visible({ providerID: "openai", modelID: "gpt" })).toBe(true)
  })
})
