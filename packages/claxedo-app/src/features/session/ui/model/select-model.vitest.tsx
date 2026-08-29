import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import type { PickerItem, PickerState } from "./select-model"

// ---------------------------------------------------------------------------
// Mocks — `DialogSelectModel` is the simplest exported wrapper around the
// shared `ModelList` commit point (no Kobalte popover open-state machinery),
// so it is the surface this test drives. Everything below is a flat stub;
// only `List`'s `onSelect` passthrough and the telemetry spy matter here.
// ---------------------------------------------------------------------------

const captured: Array<{ event: string; properties: Record<string, unknown> }> = []

vi.mock("@/platform/telemetry/analytics", () => ({
  capture: (event: string, properties: Record<string, unknown>) => {
    captured.push({ event, properties })
  },
  identityProps: () => ({ org_id: "org_1", user_id: "user_1", deployment_mode: "self-host" }),
}))

vi.mock("@opencode-ai/ui/list", () => ({
  List: (props: {
    items: PickerItem[] | ((filter: string) => PickerItem[])
    onSelect?: (value: PickerItem | undefined, index: number) => void
  }) => {
    const items = typeof props.items === "function" ? props.items("") : props.items
    return (
      <div data-testid="model-list">
        {items.map((item, index) => (
          <button
            data-testid={`model-option-${item.provider.id}-${item.id}`}
            onClick={() => props.onSelect?.(item, index)}
          >
            {item.name}
          </button>
        ))}
      </div>
    )
  },
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown; action?: unknown }) => (
    <div data-testid="dialog">
      <div data-testid="dialog-action">{props.action as never}</div>
      {props.children as never}
    </div>
  ),
}))

vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { children?: unknown; onClick?: () => void }) => (
    <button onClick={props.onClick}>{props.children as never}</button>
  ),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: () => undefined,
    close: () => undefined,
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))

vi.mock("@/features/session/app-ports", () => ({
  loadManageModelsDialog: async () => ({ DialogManageModels: () => null }),
  openSettingsProviders: vi.fn(),
}))

import { DialogSelectModel } from "./select-model"

function pickerState(items: PickerItem[]): PickerState {
  return {
    list: () => items,
    current: () => undefined,
    visible: () => true,
    set: () => undefined,
  }
}

const models: PickerItem[] = [
  { id: "claude-sonnet-4-6", name: "Sonnet", provider: { id: "anthropic", name: "Anthropic" } },
  { id: "gpt-5-6", name: "GPT-5.6", provider: { id: "openai", name: "OpenAI" } },
]

afterEach(() => {
  cleanup()
  captured.length = 0
})

describe("DialogSelectModel — model_selected telemetry", () => {
  test("selecting a model captures model_selected with an id-only property allowlist", () => {
    const { container } = render(() => <DialogSelectModel model={pickerState(models)} />)

    const option = container.querySelector("[data-testid='model-option-anthropic-claude-sonnet-4-6']") as HTMLButtonElement
    expect(option).not.toBeNull()
    option.click()

    const event = captured.find((entry) => entry.event === "model_selected")
    expect(event).toBeDefined()
    expect(event?.properties.provider_id).toBe("anthropic")
    expect(event?.properties.model_id).toBe("claude-sonnet-4-6")
    // The guard against future PII creep: this enumerates the exact allowed
    // keys. Tripwire — add a forbidden property (e.g. `title`) at the call
    // site in select-model.tsx's `ModelList.onSelect`, watch this fail, then
    // remove it.
    expect(Object.keys(event?.properties ?? {}).sort()).toEqual(
      ["deployment_mode", "model_id", "org_id", "provider_id", "surface", "user_id"].sort(),
    )
  })

  test("defaults to the composer surface, and threads an explicit surface prop through", () => {
    const { container: defaulted } = render(() => <DialogSelectModel model={pickerState(models)} />)
    ;(defaulted.querySelector("[data-testid='model-option-openai-gpt-5-6']") as HTMLButtonElement).click()
    expect(captured.find((entry) => entry.event === "model_selected")?.properties.surface).toBe("composer")
    cleanup()
    captured.length = 0

    const { container: withSurface } = render(() => (
      <DialogSelectModel model={pickerState(models)} surface="command_palette" />
    ))
    ;(withSurface.querySelector("[data-testid='model-option-openai-gpt-5-6']") as HTMLButtonElement).click()
    expect(captured.find((entry) => entry.event === "model_selected")?.properties.surface).toBe("command_palette")
  })
})
