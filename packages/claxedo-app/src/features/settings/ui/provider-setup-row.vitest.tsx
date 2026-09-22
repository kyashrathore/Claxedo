import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ProviderSetupRow } from "./provider-setup-row"

const shownDialogs = vi.hoisted(() => [] as Array<() => unknown>)
vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (element: () => unknown) => {
      shownDialogs.push(element)
      return Promise.resolve()
    },
    close: () => {},
  }),
}))
vi.mock("@/features/settings/ui/dialog-provider-connect", () => ({
  DialogProviderConnect: (props: { provider: string; harness: string; scope?: string }) => (
    <div data-testid="connect-form" data-provider={props.provider} data-harness={props.harness} data-scope={props.scope ?? ""} />
  ),
}))
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
  test("Connect opens this provider's card in a dialog, named for this provider and workspace", () => {
    render(() => (
      <ProviderSetupRow
        id="anthropic"
        name="Anthropic"
        providerId="anthropic"
        harness="claude"
        scope="workspace:ws_1"
      />
    ))

    expect(shownDialogs).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "common.connect" }))

    // In a dialog rather than under the row: the list the user came from
    // stays where it was, whether they finish or abandon.
    expect(shownDialogs).toHaveLength(1)
    render(() => shownDialogs[0]() as never)
    const form = screen.getByTestId("connect-form")
    expect(form.dataset.provider).toBe("anthropic")
    expect(form.dataset.harness).toBe("claude")
    expect(form.dataset.scope).toBe("workspace:ws_1")
    // The row keeps its place and says the dialog is open.
    expect(screen.queryByRole("button", { name: "common.connect" })).toBeNull()
  })

  test("the row carries no status tag: a catalog row this component renders is one that is not connected", () => {
    render(() => <ProviderSetupRow id="anthropic" name="Anthropic" providerId="anthropic" harness="claude" note="A note" />)

    expect(document.querySelector('[data-component="provider-actions"] [data-component="tag"]')).toBeNull()
    expect(screen.getByText("A note")).toBeTruthy()
  })
})
