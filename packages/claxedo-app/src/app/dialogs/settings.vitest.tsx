import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"

const state = vi.hoisted(() => ({
  settingsConnectionsEnabled: false,
  settingsSandboxProvidersEnabled: false,
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children: JSX.Element }) => <div>{props.children}</div>,
}))

vi.mock("@opencode-ai/ui/tabs", () => {
  const Tabs = (props: { children: JSX.Element }) => <div>{props.children}</div>
  Tabs.List = (props: { children: JSX.Element }) => <div>{props.children}</div>
  Tabs.SectionTitle = (props: { children: JSX.Element }) => <h2>{props.children}</h2>
  Tabs.Trigger = (props: { children: JSX.Element; value: string }) => <button data-value={props.value}>{props.children}</button>
  Tabs.Content = (props: { children: JSX.Element; value: string }) => <section data-value={props.value}>{props.children}</section>
  return { Tabs }
})

vi.mock("@/ui/controls/claxedo-icon", () => ({ ClaxedoIcon: () => null }))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: vi.fn() }) }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/features/settings/ui/general", () => ({ SettingsGeneral: () => <div>General content</div> }))
vi.mock("@/features/settings/ui/keybinds", () => ({ SettingsKeybinds: () => <div>Shortcuts content</div> }))
vi.mock("@/features/settings/ui/providers", () => ({ SettingsProviders: () => <div>Providers content</div> }))
vi.mock("@/features/settings/ui/models", () => ({ SettingsModels: () => <div>Models content</div> }))
vi.mock("@/features/settings/ui/terminals", () => ({ SettingsTerminals: () => <div>Terminals content</div> }))
vi.mock("@/features/settings/ui/connections", () => ({ SettingsConnections: () => <div>Connections content</div> }))
vi.mock("@/features/settings/ui/sandbox-section", () => ({ SandboxSettingsSection: () => <div>Sandbox content</div> }))
vi.mock("@/features/onboarding", () => ({
  RemoteAccessSurface: () => <div>Devices content</div>,
  useRemoteAccessController: () => ({
    availability: () => ({ status: "unavailable" }),
    workspaceLink: () => undefined,
    devices: {},
    startAtLogin: () => false,
    setStartAtLogin: vi.fn(),
    enable: vi.fn(),
    revoke: vi.fn(),
  }),
}))
vi.mock("@/app/connection/server", () => ({ useServer: () => ({ url: "http://127.0.0.1:2593" }) }))
vi.mock("@solidjs/router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@/app/providers/config", () => ({
  useConfigOptional: () => ({
    settingsConnectionsEnabled: state.settingsConnectionsEnabled,
    settingsSandboxProvidersEnabled: state.settingsSandboxProvidersEnabled,
  }),
}))

import { DialogSettings } from "./settings"

beforeEach(() => {
  state.settingsConnectionsEnabled = false
  state.settingsSandboxProvidersEnabled = false
})

afterEach(() => cleanup())

describe("DialogSettings product flags", () => {
  test("does not mount Connections or Sandbox entry points by default", () => {
    render(() => <DialogSettings />)

    expect(screen.queryByRole("button", { name: "Connections" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Sandbox" })).toBeNull()
    expect(screen.queryByText("Connections content")).toBeNull()
    expect(screen.queryByText("Sandbox content")).toBeNull()
  })

  test("mounts Connections independently when explicitly enabled", () => {
    state.settingsConnectionsEnabled = true
    render(() => <DialogSettings />)

    expect(screen.getByRole("button", { name: "Connections" })).toBeInTheDocument()
    expect(screen.getByText("Connections content")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sandbox" })).toBeNull()
    expect(screen.queryByText("Sandbox content")).toBeNull()
  })

  test("mounts Sandbox independently when explicitly enabled", () => {
    state.settingsSandboxProvidersEnabled = true
    render(() => <DialogSettings />)

    expect(screen.getByRole("button", { name: "Sandbox" })).toBeInTheDocument()
    expect(screen.getByText("Sandbox content")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connections" })).toBeNull()
    expect(screen.queryByText("Connections content")).toBeNull()
  })
})
