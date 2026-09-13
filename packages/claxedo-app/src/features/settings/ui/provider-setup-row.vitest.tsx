import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ProviderSetupRow } from "./provider-setup-row"

vi.mock("@/features/settings/app-ports", () => ({
  ProviderConnectForm: (props: { provider: string; harness: string; workspaceScope?: string; onDone: () => void }) => (
    <button data-testid="connect-form" data-provider={props.provider} data-harness={props.harness} data-scope={props.workspaceScope} onClick={props.onDone}>Done connecting</button>
  ),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
  }),
}))

afterEach(cleanup)

describe("ProviderSetupRow", () => {
  test("Connect opens this provider's card in the row, and the card's own close dismisses it", () => {
    render(() => (
      <ProviderSetupRow
        id="anthropic"
        name="Anthropic"
        providerId="anthropic"
        harness="claude"
        scope="workspace:ws_1"
      />
    ))

    expect(screen.queryByTestId("connect-form")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "common.connect" }))

    const form = screen.getByTestId("connect-form")
    expect(form.dataset.provider).toBe("anthropic")
    expect(form.dataset.harness).toBe("claude")
    expect(form.dataset.scope).toBe("workspace:ws_1")
    expect(screen.queryByRole("button", { name: "common.connect" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "common.close" }))

    expect(screen.queryByTestId("connect-form")).toBeNull()
    expect(screen.getByRole("button", { name: "common.connect" })).toBeTruthy()
  })

  test("the row carries no status tag: a catalog row this component renders is one that is not connected", () => {
    render(() => <ProviderSetupRow id="anthropic" name="Anthropic" providerId="anthropic" harness="claude" note="A note" />)

    expect(document.querySelector('[data-component="provider-actions"] [data-component="tag"]')).toBeNull()
    expect(screen.getByText("A note")).toBeTruthy()
  })
})
