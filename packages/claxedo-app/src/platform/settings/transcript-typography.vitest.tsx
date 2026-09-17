import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme/context"
import { removePersisted } from "@/platform/persistence/persist"
import { SettingsProvider, useSettings } from "./provider"
import { useTranscriptTypography, type TranscriptTypographySource } from "./transcript-typography"

type Port = { source: TranscriptTypographySource; settings: ReturnType<typeof useSettings>; theme?: ReturnType<typeof useTheme> }
let port!: Port

function Probe(props: { themed: boolean }) {
  port = {
    source: useTranscriptTypography(),
    settings: useSettings(),
    theme: props.themed ? useTheme() : undefined,
  }
  return null
}

async function mount(input: { theme?: string } = {}) {
  render(() =>
    input.theme ? (
      <ThemeProvider defaultTheme={input.theme}>
        <SettingsProvider>
          <Probe themed />
        </SettingsProvider>
      </ThemeProvider>
    ) : (
      <SettingsProvider>
        <Probe themed={false} />
      </SettingsProvider>
    ),
  )
  await waitFor(() => expect(port).toBeTruthy())
}

/** ThemeProvider reads the system scheme on init; jsdom has no matchMedia. */
beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  removePersisted({ key: "settings.v3" })
  localStorage.clear()
})

describe("useTranscriptTypography", () => {
  test("without a ThemeProvider the stored choice alone counts, and no choice is the shipped default", async () => {
    await mount()
    expect(port.source.theme()).toBeUndefined()
    expect(port.source.typography()).toEqual({ pairing: "default" })

    port.settings.appearance.setTranscriptOverride({ fontSize: 16 })
    await waitFor(() => expect(port.source.typography()).toEqual({ pairing: "default", fontSize: 16 }))
  })

  test("the Codex theme brings the codex pairing once its file loads; a stored pairing overrides it; switching theme flips it back", async () => {
    await mount({ theme: "codex" })
    await waitFor(() => expect(port.source.theme()).toEqual({ pairing: "codex" }))
    expect(port.source.typography()).toEqual({ pairing: "codex" })

    port.settings.appearance.setTranscriptOverride({ listGap: 6 })
    await waitFor(() => expect(port.source.typography()).toEqual({ pairing: "codex", listGap: 6 }))

    port.settings.appearance.setTranscriptPairing("swiss")
    await waitFor(() => expect(port.source.typography()).toEqual({ pairing: "swiss" }))

    port.settings.appearance.setTranscriptPairing(undefined)
    port.theme!.setTheme("cursor")
    await waitFor(() => expect(port.source.typography()).toEqual({ pairing: "cursor" }))

    port.theme!.setTheme("github")
    await waitFor(() => expect(port.source.typography()).toEqual({ pairing: "default" }))
  })
})
