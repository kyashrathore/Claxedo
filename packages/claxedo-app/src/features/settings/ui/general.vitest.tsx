import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { ThemeProvider } from "@opencode-ai/ui/theme"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { IdentityProvider } from "@/platform/auth/identity-provider"
import { LanguageProvider } from "@/platform/i18n/provider"
import { PlatformProvider, type Platform } from "@/platform/runtime/platform-provider"
import { SettingsProvider, useSettings } from "@/platform/settings/provider"
import { capture } from "@/platform/telemetry/analytics"
import { SettingsGeneral } from "./general"

vi.mock("@/platform/telemetry/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/telemetry/analytics")>()),
  capture: vi.fn(),
}))

vi.mock("@/features/settings/app-ports", () => ({
  Link: (props: { href: string; children: JSX.Element }) => <a href={props.href}>{props.children}</a>,
}))

const platform: Platform = {
  platform: "web",
  openLink: () => undefined,
  restart: async () => undefined,
  back: () => undefined,
  forward: () => undefined,
  notify: async () => undefined,
}

let settings: ReturnType<typeof useSettings> | undefined

function Probe() {
  settings = useSettings()
  return null
}

function mount() {
  render(() => (
    <PlatformProvider value={platform}>
      <IdentityProvider principal={{ kind: "local", deviceId: "device_1" }}>
        <LanguageProvider locale="en">
          <ThemeProvider>
            <SettingsProvider>
              <Probe />
              <SettingsGeneral />
            </SettingsProvider>
          </ThemeProvider>
        </LanguageProvider>
      </IdentityProvider>
    </PlatformProvider>
  ))
}

function placementTrigger() {
  const trigger = document.querySelector('[data-action="settings-navigator-placement"] button')
  expect(trigger).not.toBeNull()
  return trigger as HTMLButtonElement
}

function persistedPlacement() {
  const raw = localStorage.getItem("settings.v3")
  expect(raw).not.toBeNull()
  return (JSON.parse(raw as string) as { appearance: { navigatorPlacement?: string } }).appearance.navigatorPlacement
}

beforeEach(() => {
  localStorage.clear()
  settings = undefined
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(capture).mockClear()
  localStorage.clear()
})

describe("SettingsGeneral navigator placement row", () => {
  test("defaults to the workspace panel when the persisted blob predates the preference", () => {
    localStorage.setItem("settings.v3", JSON.stringify({ appearance: { navigatorSide: "left" } }))
    mount()

    expect(settings?.appearance.navigatorPlacement()).toBe("panel")
    expect(settings?.appearance.navigatorSide()).toBe("left")
    expect(placementTrigger()).toHaveTextContent("Workspace panel")
  })

  test("selecting Sidebar writes the preference, persists it under settings.v3 and captures setting_changed", async () => {
    mount()
    const setNavigatorPlacement = vi.spyOn(settings!.appearance, "setNavigatorPlacement")

    fireEvent.keyDown(placementTrigger(), { key: "ArrowDown" })
    fireEvent.click(await screen.findByRole("option", { name: "Sidebar" }))

    await waitFor(() => expect(placementTrigger()).toHaveTextContent("Sidebar"))
    expect(setNavigatorPlacement).toHaveBeenCalledWith("sidebar")
    expect(settings?.appearance.navigatorPlacement()).toBe("sidebar")
    expect(persistedPlacement()).toBe("sidebar")
    expect(capture).toHaveBeenCalledWith(
      "setting_changed",
      expect.objectContaining({ surface: "settings", setting: "navigator_placement", value: "sidebar" }),
    )
  })

  test("renders a persisted sidebar placement as the current option", () => {
    localStorage.setItem("settings.v3", JSON.stringify({ appearance: { navigatorPlacement: "sidebar" } }))
    mount()

    expect(settings?.appearance.navigatorPlacement()).toBe("sidebar")
    expect(placementTrigger()).toHaveTextContent("Sidebar")
  })
})
