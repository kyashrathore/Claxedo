import { cleanup, render, screen } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"

const state = vi.hoisted(() => ({
  settingsConnectionsEnabled: false,
  agentConnections: false,
  settingsSandboxProvidersEnabled: false,
}))

vi.mock("@/platform/query/connection-catalog", () => ({ createHarnessConnectionsCatalog: () => ({ refresh: async () => {}, data: () => ({ status: "supported", connections: state.agentConnections ? [{ connectionId: "disabled-agent", enabled: false }] : [] }) }) }))
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
// The scope selector's own sources. The provider itself stays REAL so the tab
// list is rendered under the same (workspace, harness) selection the Providers
// and Models surfaces read.
vi.mock("@/features/settings/app-ports", () => ({
  useShellQueryOptions: () => ({
    projects: () => ({
      queryKey: ["settings-vitest", "projects"],
      queryFn: async () => [{
        id: "proj_1",
        name: "acme/app",
        worktree: "/repo",
        workspaces: { "workspace:ws_1": { workspaceId: "ws_1", kind: "local", workspace_name: "main", directory: "/repo" } },
      }],
    }),
  }),
  useSDK: () => { throw new Error("no workspace SDK scope") },
  useEnabledAcpHarnesses: () => () => [],
}))
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: vi.fn() }) }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/features/settings/ui/general", () => ({ SettingsGeneral: () => <div>General content</div> }))
vi.mock("@/features/settings/ui/keybinds", () => ({ SettingsKeybinds: () => <div>Shortcuts content</div> }))
vi.mock("@/features/settings/ui/providers", () => ({ SettingsProviders: () => <div>Providers content</div> }))
vi.mock("@/features/settings/ui/models", () => ({ SettingsModels: () => <div>Models content</div> }))
vi.mock("@/features/settings/ui/terminals", () => ({ SettingsTerminals: () => <div>Terminals content</div> }))
vi.mock("@/features/settings/ui/connections", () => ({ SettingsConnections: () => <div>Connections content</div> }))
vi.mock("@/features/settings/ui/sandbox-section", () => ({ SandboxSettingsSection: () => <div>Sandbox content</div> }))
vi.mock("@/features/settings/ui/org-team-section", () => ({ OrgTeamSettingsSection: () => <div>Orgs content</div> }))
vi.mock("@/features/onboarding", () => ({
  RemoteAccessSurface: () => <div>Devices content</div>,
  useRemoteAccessController: () => ({
    availability: () => ({ state: "ready-to-enable" }),
    identity: () => ({ state: "signed-out" }),
    deviceLink: () => "https://app.claxedo.test/",
    devices: {},
    startAtLogin: () => false,
    setStartAtLogin: vi.fn(),
    enable: vi.fn(),
    canPause: () => false,
    pause: vi.fn(),
    revoke: vi.fn(),
  }),
}))
// The Devices tab's machine-level auto-share is exercised by its own suite;
// this one is about which tabs a product mounts, and outside the app shell
// there is no provider for the panel's status reader to find.
vi.mock("@/features/workspaces/data/auto-share-local-workspaces", () => ({
  useLocalWorkspaceAutoShareStatus: () => ({}),
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
import { registerSettingsSection } from "@/app/integrations/settings-sections"

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(() => (
    <QueryClientProvider client={client}>
      <DialogSettings />
    </QueryClientProvider>
  ))
}

beforeEach(() => {
  state.agentConnections = false
  state.settingsConnectionsEnabled = false
  state.settingsSandboxProvidersEnabled = false
})

afterEach(() => cleanup())

describe("DialogSettings product flags", () => {
  test("does not mount Connections or Sandbox entry points by default", () => {
    mount()

    expect(screen.queryByRole("button", { name: "Connections" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Sandbox" })).toBeNull()
    expect(screen.queryByText("Connections content")).toBeNull()
    expect(screen.queryByText("Sandbox content")).toBeNull()
  })

  test("mounts Connections independently when explicitly enabled", () => {
    state.settingsConnectionsEnabled = true
    mount()

    expect(screen.getByRole("button", { name: "Connections" })).toBeInTheDocument()
    expect(screen.getByText("Connections content")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sandbox" })).toBeNull()
    expect(screen.queryByText("Sandbox content")).toBeNull()
  })

  test("mounts Sandbox independently when explicitly enabled", () => {
    state.settingsSandboxProvidersEnabled = true
    mount()

    expect(screen.getByRole("button", { name: "Sandbox" })).toBeInTheDocument()
    expect(screen.getByText("Sandbox content")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connections" })).toBeNull()
    expect(screen.queryByText("Connections content")).toBeNull()
  })
})

describe("DialogSettings section naming", () => {
  test("Providers and Models sit under the workspace section, not a server one", () => {
    mount()

    expect(screen.getByRole("heading", { name: "settings.section.workspace" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "settings.section.server" })).toBeNull()
  })

  test("the account section appears only with an account-scoped tab in it", () => {
    mount()
    expect(screen.queryByRole("heading", { name: "settings.section.account" })).toBeNull()
    cleanup()

    state.settingsConnectionsEnabled = true
    mount()
    expect(screen.getByRole("heading", { name: "settings.section.account" })).toBeInTheDocument()
  })
})

describe("DialogSettings contributed sections", () => {
  test("a contributed workspace section is a tab whose value is its id", () => {
    registerSettingsSection({
      id: "vitest.presets",
      tier: "claxedo-first-party",
      section: "workspace",
      label: "Contributed",
      renderer: () => <div>Contributed content</div>,
    })

    mount()

    const trigger = screen.getByRole("button", { name: "Contributed" })
    expect(trigger).toBeInTheDocument()
    // The opener passes this id as `initialTab`, so the trigger and the content
    // have to answer to it and not to the label.
    expect(trigger.getAttribute("data-value")).toBe("vitest.presets")
    expect(screen.getByText("Contributed content")).toBeInTheDocument()
  })

  test("a section gated to another workspace is not offered", () => {
    registerSettingsSection({
      id: "vitest.elsewhere",
      tier: "claxedo-first-party",
      section: "workspace",
      label: "Elsewhere",
      gate: { workspaceId: "ws_other" },
      renderer: () => <div>Elsewhere content</div>,
    })

    mount()

    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull()
    expect(screen.queryByText("Elsewhere content")).toBeNull()
  })

  // The counterpart the test above cannot supply on its own: gated against an
  // empty context every `workspaceId` gate fails, so that one stays green while
  // the dialog gates against no workspace at all.
  test("a section gated to the workspace this dialog resolved is offered", async () => {
    registerSettingsSection({
      id: "vitest.here",
      tier: "claxedo-first-party",
      section: "workspace",
      label: "Here",
      gate: { workspaceId: "ws_1" },
      renderer: () => <div>Here content</div>,
    })

    mount()

    expect(await screen.findByRole("button", { name: "Here" })).toBeInTheDocument()
    expect(screen.getByText("Here content")).toBeInTheDocument()
  })

  test("a contributed desktop section is a tab like the workspace ones", () => {
    registerSettingsSection({
      id: "vitest.desktop",
      tier: "claxedo-first-party",
      section: "desktop",
      label: "Contributed desktop",
      renderer: () => <div>Contributed desktop content</div>,
    })

    mount()

    expect(screen.getByRole("button", { name: "Contributed desktop" })).toBeInTheDocument()
    expect(screen.getByText("Contributed desktop content")).toBeInTheDocument()
  })

  test("a contributed account section brings the account group with it", () => {
    registerSettingsSection({
      id: "vitest.account",
      tier: "claxedo-first-party",
      section: "account",
      label: "Contributed account",
      renderer: () => <div>Contributed account content</div>,
    })

    mount()

    expect(screen.getByRole("heading", { name: "settings.section.account" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Contributed account" })).toBeInTheDocument()
    expect(screen.getByText("Contributed account content")).toBeInTheDocument()
  })
})

test("configured ACP connections expose administration even without external integrations", () => {
 state.agentConnections = true
 mount()
 expect(screen.getByRole("button", { name: "Connections" })).toBeInTheDocument()
 expect(screen.getByText("Connections content")).toBeInTheDocument()
})
