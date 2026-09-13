import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { ComponentProps } from "solid-js"
import { ProviderSetupRow, providerSetupStatusLabel, type ProviderAccount } from "./provider-setup-row"

vi.mock("@/features/settings/app-ports", () => ({
  ProviderConnectForm: (props: { provider: string; harness: string; workspaceScope?: string; onDone: () => void }) => (
    <button data-testid="connect-form" data-provider={props.provider} data-harness={props.harness} data-scope={props.workspaceScope} onClick={props.onDone}>Done connecting</button>
  ),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

afterEach(cleanup)

describe("ProviderSetupRow", () => {
  test("does not show a status tag when the provider is missing (not connected)", () => {
    render(() => (
      <ProviderSetupRow
        id="anthropic"
        name="Anthropic"
        status="missing"
        providerId="anthropic"
        harness="claude"
        scope="workspace:ws_1"
      />
    ))

    expect(screen.queryByText("settings.providers.status.notConnected")).toBeNull()
    expect(screen.getByRole("button", { name: "common.connect" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "common.connect" }))
    const form = screen.getByTestId("connect-form")
    expect(form.dataset.provider).toBe("anthropic")
    expect(form.dataset.harness).toBe("claude")
    expect(form.dataset.scope).toBe("workspace:ws_1")
    fireEvent.click(form)
    expect(screen.queryByTestId("connect-form")).toBeNull()
  })

  test("shows connected status for connected providers", () => {
    render(() => (
      <ProviderSetupRow
        id="anthropic"
        name="Anthropic"
        status="connected"
        providerId="anthropic"
        harness="claude"
        scope="workspace:ws_1"
      />
    ))

    expect(screen.getByText("settings.providers.status.connected")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "common.connect" })).toBeNull()
  })
})

describe("ProviderSetupRow accounts", () => {
  const account = (over: Partial<ProviderAccount>): ProviderAccount => ({
    id: "cred_1",
    ids: ["cred_1"],
    name: "Old key",
    isActive: true,
    ...over,
  })

  function row(accounts: readonly ProviderAccount[], extra: Partial<ComponentProps<typeof ProviderSetupRow>> = {}) {
    return render(() => (
      <ProviderSetupRow
        id="anthropic"
        name="Claude Code"
        status="connected"
        providerId="claude-sdk"
        harness="claude"
        accounts={accounts}
        onRemove={() => undefined}
        {...extra}
      />
    ))
  }

  test("a rejected account is tagged in the danger tone with its time behind it", () => {
    row([account({ health: { label: "Rejected by the provider", note: "Checked just now", rejected: true } })])

    const health = document.querySelector('[data-component="provider-account-health"]')!
    expect(health.querySelector('[data-component="tag"]')?.getAttribute("data-tone")).toBe("danger")
    expect(health.querySelector('[data-component="tag"]')?.textContent).toBe("Rejected by the provider")
    expect(health.textContent).toContain("Checked just now")
  })

  test("a rejected account offers Reconnect, which opens this provider's connect card", () => {
    row([account({ health: { label: "Rejected by the provider", rejected: true } })])
    expect(document.querySelector('[data-component="provider-connect-card"]')).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "settings.providers.agents.reconnectAccount" }))

    expect(screen.getByTestId("connect-form").dataset.provider).toBe("claude-sdk")
  })

  test("a working account offers no Reconnect and no danger tag", () => {
    row([account({ health: { label: "Working", note: "Checked just now", rejected: false } })])

    expect(screen.queryByRole("button", { name: "settings.providers.agents.reconnectAccount" })).toBeNull()
    expect(document.querySelector('[data-component="provider-account-health"] [data-component="tag"]')).toBeNull()
    expect(screen.getByRole("button", { name: "settings.providers.agents.removeAccount" })).toBeTruthy()
  })

  test("Check is offered per account, and not at all on a row given no way to check", () => {
    const checked: string[][] = []
    row([account({})], { onCheckAccount: (ids) => void checked.push([...ids]) })

    fireEvent.click(screen.getByRole("button", { name: "settings.providers.agents.check" }))

    expect(checked).toEqual([["cred_1"]])
    cleanup()

    row([account({})])
    expect(screen.queryByRole("button", { name: "settings.providers.agents.check" })).toBeNull()
  })
})

describe("providerSetupStatusLabel", () => {
  const language = { t: (key: string) => key }

  test("maps setup statuses to i18n keys", () => {
    expect(providerSetupStatusLabel("connected", language as never)).toBe("settings.providers.status.connected")
    expect(providerSetupStatusLabel("detected", language as never)).toBe("settings.providers.status.detected")
    expect(providerSetupStatusLabel("broken", language as never)).toBe("settings.providers.status.broken")
    expect(providerSetupStatusLabel("missing", language as never)).toBe("settings.providers.status.notConnected")
  })
})
