import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ProviderSetupRow, providerSetupStatusLabel } from "./provider-setup-row"

vi.mock("@/features/settings/app-ports", () => ({
  ProviderConnectForm: () => <div data-testid="connect-form" />,
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
      />
    ))

    expect(screen.queryByText("settings.providers.status.notConnected")).toBeNull()
    expect(screen.getByRole("button", { name: "common.connect" })).toBeTruthy()
  })

  test("shows connected status for connected providers", () => {
    render(() => (
      <ProviderSetupRow
        id="anthropic"
        name="Anthropic"
        status="connected"
        providerId="anthropic"
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
