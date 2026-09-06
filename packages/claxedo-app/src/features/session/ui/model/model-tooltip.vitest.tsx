import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import type { PickerItem } from "./select-model"

// The card's only consumer is `select-model.tsx`'s `itemWrapper`, which hands it
// a `PickerItem`. `limit` used to be REQUIRED here while `PickerItem` did not
// declare it at all — the mismatch typechecked only because the item was
// asserted into this shape at the call site, and a catalog entry without a
// context window would have thrown on `props.model.limit.context`.
vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${Object.values(params).join(",")}` : key,
  }),
}))

const { ModelTooltip } = await import("./model-tooltip")

afterEach(cleanup)

const item = (overrides: Partial<PickerItem> = {}): PickerItem => ({
  id: "sonnet",
  name: "Sonnet",
  provider: { id: "anthropic", name: "Anthropic" },
  ...overrides,
})

describe("ModelTooltip", () => {
  test("renders a picker item that carries no context limit", () => {
    const view = render(() => <ModelTooltip model={item()} />)

    expect(view.queryByText(/model\.tooltip\.context/)).toBeNull()
    expect(view.getByText(/model\.tooltip\.reasoning/)).not.toBeNull()
  })

  test("renders the context line when the catalog supplied a limit", () => {
    const view = render(() => <ModelTooltip model={item({ limit: { context: 200_000 } })} />)

    expect(view.getByText(`model.tooltip.context:${(200_000).toLocaleString()}`)).not.toBeNull()
  })
})
