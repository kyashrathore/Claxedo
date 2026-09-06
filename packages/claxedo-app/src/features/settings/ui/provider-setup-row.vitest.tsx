import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ProviderSetupRow, providerSetupStatusLabel } from "./provider-setup-row"

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

describe("providerSetupStatusLabel", () => {
  const language = { t: (key: string) => key }

  test("maps setup statuses to i18n keys", () => {
    expect(providerSetupStatusLabel("connected", language as never)).toBe("settings.providers.status.connected")
    expect(providerSetupStatusLabel("detected", language as never)).toBe("settings.providers.status.detected")
    expect(providerSetupStatusLabel("broken", language as never)).toBe("settings.providers.status.broken")
    expect(providerSetupStatusLabel("missing", language as never)).toBe("settings.providers.status.notConnected")
  })
})
