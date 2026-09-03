import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

const providerState = vi.hoisted(() => ({
  connected: [
    { id: "anthropic", name: "Anthropic", models: {} },
    { id: "openai", name: "OpenAI", models: {} },
  ],
  loaded: [] as string[],
}))

vi.mock("@/app/providers/use-providers", () => ({
  popularProviders: ["anthropic", "openai", "google"],
}))

// The dialog no longer holds a catalog of its own: the pane's model store owns
// the catalog of the (workspace, harness) it is mounted for, and `hydrate()` is
// the one call that expands its connected providers.
vi.mock("@/features/session/providers/session-selection", () => ({
  useLocal: () => ({
    model: {
      list: () => [],
      visible: () => true,
      setVisibility: () => undefined,
      hydrate: async () => {
        for (const provider of providerState.connected) providerState.loaded.push(provider.id)
      },
    },
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: () => undefined }),
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => <div>{props.children as never}</div>,
}))

vi.mock("@opencode-ai/ui/list", () => ({
  List: () => <div data-testid="model-list" />,
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown }) => <button>{props.children as never}</button>,
}))

vi.mock("@opencode-ai/ui/switch", () => ({ Switch: () => null }))
vi.mock("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
vi.mock("@/app/dialogs/select-provider", () => ({ DialogSelectProvider: () => null }))

const { DialogManageModels } = await import("./manage-models")

afterEach(() => {
  cleanup()
  providerState.loaded.length = 0
})

describe("DialogManageModels provider detail loading", () => {
  test("expands every configured provider when the dialog opens", async () => {
    render(() => <DialogManageModels />)

    await waitFor(() => {
      expect(providerState.loaded.sort()).toEqual(["anthropic", "openai"])
    })
  })

  test("does not expand providers that are only present in the catalog", async () => {
    render(() => <DialogManageModels />)

    await waitFor(() => expect(providerState.loaded.length).toBe(2))
    expect(providerState.loaded).not.toContain("google")
  })
})
