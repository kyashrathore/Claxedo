import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

vi.mock("@opencode-ai/ui/theme/context", () => ({
  useTheme: () => ({
    loadThemes: async () => {},
    ids: () => ["opencode"],
    name: (id: string) => id,
    themeId: () => "opencode",
    setTheme: () => {},
    previewTheme: () => () => {},
    colorScheme: () => "system",
    setColorScheme: () => {},
    previewColorScheme: () => () => {},
    cancelPreview: () => {},
  }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({
  usePlatform: () => ({ version: "1.0.0" }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    locale: () => "en",
    locales: ["en"],
    label: (locale: string) => locale,
    setLocale: () => {},
  }),
}))

vi.mock("@/platform/telemetry/analytics", () => ({
  capture: () => {},
  captureException: () => {},
  identityProps: () => ({}),
}))

vi.mock("@/platform/auth/role", () => ({ Can: () => null }))
vi.mock("@/features/settings/app-ports", () => ({ Link: (props: { children?: unknown }) => props.children }))
vi.mock("@/features/settings/ui/account-section", () => ({ AccountSettingsSection: () => null }))
vi.mock("@/features/settings/ui/connected-apps-section", () => ({ ConnectedAppsSettingsSection: () => null }))

const { SettingsProvider, useSettings } = await import("@/platform/settings/provider")
const { removePersisted } = await import("@/platform/persistence/persist")
const { SettingsGeneral } = await import("./general")

const reasoningSwitch = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    '[data-action="settings-feed-reasoning-summaries"] [data-slot="switch-input"]',
  )

/** The stored answer as every reader of the setting sees it, not the DOM's copy. */
let stored!: { read: () => boolean; write: (value: boolean) => void }

function SettingsPort() {
  const settings = useSettings()
  stored = {
    read: () => settings.general.showReasoningSummaries(),
    write: (value) => settings.general.setShowReasoningSummaries(value),
  }
  return null
}

async function mount() {
  const view = render(() => (
    <SettingsProvider>
      <SettingsPort />
      <SettingsGeneral />
    </SettingsProvider>
  ))
  await waitFor(() => expect(reasoningSwitch(view.container)).toBeTruthy())
  return { reasoning: () => reasoningSwitch(view.container)! }
}

// The persist layer keeps an in-memory copy that outlives `localStorage.clear()`.
afterEach(() => {
  cleanup()
  removePersisted({ key: "settings.v3" })
})

describe("SettingsGeneral show-reasoning-summaries row", () => {
  test("the switch shows the stored answer, in both directions", async () => {
    const view = await mount()

    stored.write(true)
    await waitFor(() => expect(view.reasoning().checked).toBe(true))

    stored.write(false)
    await waitFor(() => expect(view.reasoning().checked).toBe(false))
  })

  test("toggling the switch writes the new answer to the setting", async () => {
    const view = await mount()
    stored.write(true)
    await waitFor(() => expect(view.reasoning().checked).toBe(true))

    fireEvent.click(view.reasoning())

    await waitFor(() => expect(stored.read()).toBe(false))
    expect(view.reasoning().checked).toBe(false)
  })

  test("no row offers to fold a turn the session is still working on", async () => {
    await mount()
    expect(document.body.textContent).not.toContain("timelineFoldWhileRunning")
  })
})
