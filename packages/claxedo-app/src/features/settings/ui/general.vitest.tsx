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

const foldSwitch = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    '[data-action="settings-feed-timeline-fold-while-running"] [data-slot="switch-input"]',
  )

/** The stored answer as every reader of the setting sees it, not the DOM's copy. */
let stored!: { read: () => boolean; write: (value: boolean) => void }

function SettingsPort() {
  const settings = useSettings()
  stored = {
    read: () => settings.general.timelineFoldWhileRunning(),
    write: (value) => settings.general.setTimelineFoldWhileRunning(value),
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
  await waitFor(() => expect(foldSwitch(view.container)).toBeTruthy())
  return { fold: () => foldSwitch(view.container)! }
}

// The persist layer keeps an in-memory copy that outlives `localStorage.clear()`.
afterEach(() => {
  cleanup()
  removePersisted({ key: "settings.v3" })
})

describe("SettingsGeneral fold-a-running-turn row", () => {
  test("the switch shows the stored answer, in both directions", async () => {
    const view = await mount()

    stored.write(true)
    await waitFor(() => expect(view.fold().checked).toBe(true))

    stored.write(false)
    await waitFor(() => expect(view.fold().checked).toBe(false))
  })

  test("toggling the switch writes the new answer to the setting", async () => {
    const view = await mount()
    stored.write(true)
    await waitFor(() => expect(view.fold().checked).toBe(true))

    fireEvent.click(view.fold())

    await waitFor(() => expect(stored.read()).toBe(false))
    expect(view.fold().checked).toBe(false)
  })
})

const transcriptTrigger = (container: HTMLElement, action: string) =>
  container.querySelector<HTMLButtonElement>(`[data-action="${action}"] [data-slot="select-select-trigger"]`)

/** jsdom has no PointerEvent, so the trigger's pointerdown path never sees `button`; ArrowDown opens it too. */
const openSelect = (trigger: HTMLButtonElement) => fireEvent.keyDown(trigger, { key: "ArrowDown" })

describe("SettingsGeneral transcript typography rows (dev-only knob)", () => {
  let port!: ReturnType<typeof useSettings>["appearance"]
  function AppearancePort() {
    port = useSettings().appearance
    return null
  }
  async function mountTranscript() {
    const view = render(() => (
      <SettingsProvider>
        <AppearancePort />
        <SettingsGeneral />
      </SettingsProvider>
    ))
    await waitFor(() => expect(transcriptTrigger(view.container, "settings-transcript-pairing")).toBeTruthy())
    return view
  }

  test("the rows exist only in a dev build", async () => {
    vi.stubEnv("DEV", false)
    try {
      const view = render(() => (
        <SettingsProvider>
          <SettingsGeneral />
        </SettingsProvider>
      ))
      await waitFor(() => expect(foldSwitch(view.container)).toBeTruthy())
      expect(transcriptTrigger(view.container, "settings-transcript-pairing")).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test("each row shows the stored answer: the pairing by name, an absent override as follow-pairing", async () => {
    const view = await mountTranscript()
    port.setTranscriptPairing("editorial")
    port.setTranscriptOverride({ mono: "menlo", fontSize: 16, codeFontSize: 14, headingScale: "clear", inlineCode: "tint", bodyWeight: 430 })

    await waitFor(() =>
      expect(transcriptTrigger(view.container, "settings-transcript-pairing")).toHaveTextContent("Editorial"),
    )
    expect(transcriptTrigger(view.container, "settings-transcript-body-face")).toHaveTextContent("Follow pairing")
    expect(transcriptTrigger(view.container, "settings-transcript-mono-face")).toHaveTextContent("Menlo")
    expect(transcriptTrigger(view.container, "settings-transcript-font-size")).toHaveTextContent("16 px")
    expect(transcriptTrigger(view.container, "settings-transcript-line-height")).toHaveTextContent("Follow pairing")
    expect(transcriptTrigger(view.container, "settings-transcript-code-font-size")).toHaveTextContent("14 px")
    expect(transcriptTrigger(view.container, "settings-transcript-heading-scale")).toHaveTextContent("Clear")
    expect(transcriptTrigger(view.container, "settings-transcript-measure")).toHaveTextContent("Follow pairing")
    expect(transcriptTrigger(view.container, "settings-transcript-inline-code")).toHaveTextContent("Tint, no ring")
    expect(transcriptTrigger(view.container, "settings-transcript-body-weight")).toHaveTextContent("430")
    expect(transcriptTrigger(view.container, "settings-transcript-prose-color")).toHaveTextContent("Follow pairing")
  })

  test("picking a body face writes that override and leaves the pairing alone", async () => {
    const view = await mountTranscript()
    port.setTranscriptPairing("quiet")
    await waitFor(() => expect(transcriptTrigger(view.container, "settings-transcript-pairing")).toHaveTextContent("Quiet"))

    openSelect(transcriptTrigger(view.container, "settings-transcript-body-face")!)
    const option = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="option"][data-key="charter"]')
      expect(found).toBeTruthy()
      return found!
    })
    fireEvent.click(option)

    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "quiet", body: "charter" }))
    expect(transcriptTrigger(view.container, "settings-transcript-body-face")).toHaveTextContent("Charter")
  })

  test("reset returns to the shipped pairing with no overrides and disables itself there", async () => {
    const view = await mountTranscript()
    const reset = () => view.container.querySelector<HTMLButtonElement>('[data-action="settings-transcript-reset"]')!
    expect(reset().disabled).toBe(true)

    port.setTranscriptPairing("classic")
    port.setTranscriptOverride({ measure: 64 })
    await waitFor(() => expect(reset().disabled).toBe(false))

    fireEvent.click(reset())

    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "default" }))
    expect(reset().disabled).toBe(true)
  })

  test("an enumerated row writes the knob's own type and 'follow pairing' clears it", async () => {
    const view = await mountTranscript()
    openSelect(transcriptTrigger(view.container, "settings-transcript-rules")!)
    const visible = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="option"][data-key="visible"]')
      expect(found).toBeTruthy()
      return found!
    })
    fireEvent.click(visible)
    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "default", rules: "visible" }))

    openSelect(transcriptTrigger(view.container, "settings-transcript-rules")!)
    const auto = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="option"][data-key="auto"]')
      expect(found).toBeTruthy()
      return found!
    })
    fireEvent.click(auto)
    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "default" }))
  })

  test("picking a pairing drops every override", async () => {
    const view = await mountTranscript()
    port.setTranscriptOverride({ heading: "newyork", lineHeight: 1.7 })
    await waitFor(() => expect(transcriptTrigger(view.container, "settings-transcript-line-height")).toHaveTextContent("1.7"))

    openSelect(transcriptTrigger(view.container, "settings-transcript-pairing")!)
    const option = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="option"][data-key="swiss"]')
      expect(found).toBeTruthy()
      return found!
    })
    fireEvent.click(option)

    await waitFor(() => expect(port.transcript()).toEqual({ pairing: "swiss" }))
    expect(transcriptTrigger(view.container, "settings-transcript-heading-face")).toHaveTextContent("Follow pairing")
  })
})
