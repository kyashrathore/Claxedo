/** Native catalog transport and provider-management affordances use the real hooks. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"

const clients = new Set<QueryClient>()
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { nativeHarness, connectionHarness, harnessSelectionKey, type HarnessSelection } from "@/platform/identity/harness-selection"

type CatalogProject = {
  id: string
  name: string
  worktree: string
  workspaces: Record<string, { workspaceId: string; kind: string; workspace_name: string; directory: string }>
}

const LOCAL_PROJECT: CatalogProject = {
  id: "proj_local",
  name: "acme/app",
  worktree: "/repo",
  workspaces: { "/repo": { workspaceId: "ws_local", kind: "local", workspace_name: "main", directory: "/repo" } },
}

const CLOUD_PROJECT: CatalogProject = {
  id: "proj_cloud",
  name: "acme/api",
  worktree: "workspace:ws_cloud",
  workspaces: {
    "workspace:ws_cloud": { workspaceId: "ws_cloud", kind: "cloud", workspace_name: "sandbox", directory: "/workspace" },
  },
}

const state = vi.hoisted(() => ({
  /** Every (scope, harness) pair the page asked a catalog for, in order. */
  requests: [] as Array<{ scope?: string; harness: string }>,
  catalogs: {} as Record<string, string[]>,
  sources: {} as Record<string, "api" | "custom" | "config" | "env">,
  connected: [] as string[],
  credentialDeletes: [] as Array<{ providerId: string; method?: string }>,
  authDeletes: [] as string[],
  authReads: [] as string[],
  /** The harness the workspace's draft-default record remembers, if any. */
  rememberedHarness: undefined as HarnessSelection | undefined,
  projects: [] as CatalogProject[],
  /** What the credential store already holds, as the list route reports it. */
  storedCredentials: [] as Array<{ provider_id: string }>,
  /** What a machine scan finds, as the discovery route reports it. */
  discoveryItems: [] as Array<Record<string, unknown>>,
  credentialCalls: [] as string[],
  dialogs: [] as Array<() => JSX.Element>,
}))

vi.mock("@/features/settings/app-ports", async () => {
  const { useProviders } = await import("@/app/providers/use-providers")
  const { discoverAIConnections } = await import("@/features/onboarding/ai-connect-api")
  const { groupDiscoveryItems, localHarnessChecks, localHarnessStatuses } = await import(
    "@/features/onboarding/ai-connect-state"
  )
  return {
    useProviders,
    discoverAIConnections,
    groupDiscoveryItems,
    localHarnessStatuses,
    localHarnessChecks: () => localHarnessChecks,
    useShellQueryOptions: () => ({
      projects: () => ({
        queryKey: ["providers-vitest", "projects", state.projects.map((project) => project.id).join(",")],
        queryFn: async () => state.projects,
      }),
    }),
    useSDK: () => {
      throw new Error("no workspace SDK scope")
    },
    useEnabledAcpHarnesses: () => () => [
      { key: "team-agent", label: "Team Agent" },
      { key: "opencode", label: "External OpenCode" },
      { key: "pi", label: "External Pi" },
    ],
    readWorkspaceHarnessDefault: () => state.rememberedHarness,
    DialogAIConnect: () => <div data-testid="ai-connect-dialog" />,
    DialogCustomProvider: (props: { scope?: string }) => (
      <div data-testid="custom-provider-dialog" data-scope={props.scope ?? ""} />
    ),
    ProviderConnectForm: () => <div data-testid="provider-connect-form" />,
  }
})

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => {
    throw new Error("no focused workspace")
  },
}))
vi.mock("@/features/workspaces/data/use-workspace-query", async () => {
  const { useQuery } = await import("@tanstack/solid-query")
  return { useWorkspaceQuery: useQuery }
})
vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({
    providers: (scope: string | null, harness: string) => ({
      queryKey: ["providers", scope, harness],
      queryFn: async () => {
        state.requests.push({ scope: scope ?? undefined, harness })
        const ids = state.catalogs[`${scope ?? ""}|${harness}`] ?? []
        return {
          all: new Map(ids.map((id) => [id, { id, name: id, models: {}, source: state.sources[id] ?? "api" }])),
          connected: state.connected.filter((id) => ids.includes(id)),
          default: {},
        }
      },
    }),
  }),
}))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
    locale: () => "en",
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: (element: () => JSX.Element) => {
      state.dialogs.push(element)
    },
  }),
}))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/api/api")>()),
  authFetch: async (url: URL, init?: RequestInit) => {
    if (init?.method === "DELETE") {
      state.authDeletes.push(url.toString())
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
      state.connected = state.connected.filter((item) => item !== id)
    } else {
      state.authReads.push(url.toString())
    }
    return new Response("{}")
  },
  getClaxedoServerUrl: () => "http://127.0.0.1:2593",
}))

// The two pickers are the surface under test, so they render as native selects
// whose options and change events the test can drive directly.
vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: {
    "data-action"?: string
    options: Array<Record<string, string>>
    current?: Record<string, string>
    value: (option: Record<string, string>) => string
    onSelect: (option: Record<string, string>) => void
  }) => (
    <select
      data-testid={props["data-action"]}
      value={props.current ? props.value(props.current) : ""}
      onChange={(event) => {
        const next = props.options.find((option) => props.value(option) === event.currentTarget.value)
        if (next) props.onSelect(next)
      }}
    >
      <option value="" disabled />
      {props.options.map((option) => (
        <option value={props.value(option)}>{props.value(option)}</option>
      ))}
    </select>
  ),
}))

const { SettingsScopeProvider } = await import("@/features/settings/scope/settings-scope")
const { SettingsProviders } = await import("./providers")
const { useProviderAuth } = await import("@/app/providers/use-providers")

// The credential routes are the only network the agents section has; leaving the
// real request module in place keeps the machine scan on the onboarding engine.
globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  state.credentialCalls.push(`${init?.method ?? "GET"} ${url.pathname}`)
  if (url.pathname === "/api/claxedo/credentials") {
    return new Response(JSON.stringify({ credentials: state.storedCredentials }))
  }
  if (url.pathname === "/api/claxedo/credentials/discover") {
    return new Response(JSON.stringify({ discovery_id: "disc_1", items: state.discoveryItems }))
  }
  if (url.pathname.startsWith("/api/claxedo/credentials/provider/")) {
    state.credentialDeletes.push({
      providerId: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
      method: init?.method,
    })
    return new Response("{}")
  }
  return new Response("not found", { status: 404 })
}) as typeof globalThis.fetch

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  return render(() => (
    <QueryClientProvider client={client}>
      <SettingsScopeProvider>
        <SettingsProviders />
      </SettingsScopeProvider>
    </QueryClientProvider>
  ))
}

function section(name: "pi" | "opencode" | "agents") {
  const root = document.querySelector<HTMLElement>(`[data-component="${name}-providers-section"]`)
  if (!root) throw new Error(`${name} section is not on the page`)
  return root
}

/** The provider rows one section rendered, by id. */
function providerIds(name: "pi" | "opencode" | "agents") {
  return [...section(name).querySelectorAll<HTMLElement>("[data-provider]")]
    .map((node) => node.getAttribute("data-provider") ?? "")
    .filter(Boolean)
    .sort()
}

function detectButton() {
  const button = section("agents").querySelector<HTMLElement>('[data-action="settings-providers-detect"]')
  if (!button) throw new Error("no detect button")
  return button
}

function agentRow(id: string) {
  const row = section("agents").querySelector<HTMLElement>(`[data-provider="${id}"]`)
  if (!row) throw new Error(`no agent row for ${id}`)
  return row
}

/** The status tag a row shows, or "" where a missing row shows none. */
function agentStatus(id: string) {
  return agentRow(id).querySelector('[data-component="tag"]')?.textContent ?? ""
}

function select(testId: string) {
  return screen.getByTestId(testId)
}

function choose(testId: string, value: string) {
  const element = select(testId)
  element.value = testId === "settings-scope-harness" ? encodeURIComponent(value) : value
  element.dispatchEvent(new Event("change", { bubbles: true }))
}

beforeEach(() => {
  state.requests.length = 0
  state.rememberedHarness = nativeHarness("pi")
  state.connected = []
  state.sources = {}
  state.credentialDeletes.length = 0
  state.authDeletes.length = 0
  state.authReads.length = 0
  state.credentialCalls.length = 0
  state.dialogs.length = 0
  state.storedCredentials = []
  state.discoveryItems = []
  state.projects = [LOCAL_PROJECT, CLOUD_PROJECT]
  state.catalogs = {
    "workspace:ws_local|pi": ["anthropic", "openai"],
    "workspace:ws_local|opencode": ["external-backend"],
    "workspace:ws_local|claude": ["claude"],
    "workspace:ws_cloud|pi": ["cloud-backend"],
    "workspace:ws_cloud|opencode": ["cloud-opencode"],
  }
})

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients.clear()
})

describe("Settings → Providers reads under the selected (workspace, harness)", () => {
  test("provider authentication waits for explicit selection and uses the control plane", async () => {
    const [harness, setHarness] = createSignal("")
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.add(client)
    const Probe = () => {
      const query = useProviderAuth(harness, () => "workspace:ws_local")
      return <div data-testid="auth-state">{query.isFetching ? "loading" : "idle"}</div>
    }
    render(() => (
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    ))
    await waitFor(() => expect(screen.getByTestId("auth-state")).toHaveTextContent("idle"))
    expect(state.authReads).toEqual([])
    setHarness("pi")
    await waitFor(() =>
      expect(state.authReads).toEqual([
        "http://127.0.0.1:2593/api/claxedo/agent-config/providers/auth?nativeHarness=pi",
      ]),
    )
  })

  test("both credential stores are read for the selected workspace, each under its own harness", async () => {
    mount()
    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("/repo"))
    expect(select("settings-scope-harness").value).toBe(encodeURIComponent(harnessSelectionKey(nativeHarness("pi"))))
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
    expect(providerIds("opencode")).toEqual(["external-backend"])
    expect([...state.requests].sort((a, b) => a.harness.localeCompare(b.harness))).toEqual([
      { scope: "workspace:ws_local", harness: "opencode" },
      { scope: "workspace:ws_local", harness: "pi" },
    ])
  })

  test.each([nativeHarness("claude"), nativeHarness("cursor"), connectionHarness("team-agent")])(
    "%j is named as managing its own credentials, and Claxedo's own stores stay on the page",
    async (harness) => {
      state.rememberedHarness = harness
      mount()
      await waitFor(() =>
        expect(select("settings-scope-harness").value).toBe(encodeURIComponent(harnessSelectionKey(harness))))
      expect(document.querySelector('[data-component="providers-externally-managed"]')).not.toBeNull()
      await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
      expect(state.requests.some((request) => request.harness === harnessSelectionKey(harness))).toBe(false)
    },
  )

  test("a harness that keeps its credentials in Claxedo is not called externally managed", async () => {
    mount()
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
    expect(document.querySelector('[data-component="providers-externally-managed"]')).toBeNull()
  })

  test("catalog caches stay isolated when changing workspace", async () => {
    mount()
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
    choose("settings-scope-workspace", "ws_cloud")
    await waitFor(() => expect(providerIds("pi")).toEqual(["cloud-backend"]))
    expect(providerIds("opencode")).toEqual(["cloud-opencode"])
    choose("settings-scope-workspace", "/repo")
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
  })

  test("the workspace picker is hidden when the catalog offers a single workspace", async () => {
    state.projects = [LOCAL_PROJECT]
    mount()
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
    expect(screen.queryByTestId("settings-scope-workspace")).toBeNull()
    expect(state.requests.every((request) => request.scope === "workspace:ws_local")).toBe(true)
  })

  test("a workspace that remembers no harness still names one, so neither surface renders blank", async () => {
    state.rememberedHarness = undefined
    mount()
    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("/repo"))
    expect(select("settings-scope-harness").value).toBe(encodeURIComponent(harnessSelectionKey(nativeHarness("opencode"))))
    await waitFor(() => expect(providerIds("opencode")).toEqual(["external-backend"]))
  })

  test("an unavailable remembered connection stays unselected instead of substituting a native harness", async () => {
    state.rememberedHarness = connectionHarness("removed-connection")
    mount()
    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("/repo"))
    expect(select("settings-scope-harness").value).toBe("")
  })

  test("config and environment providers cannot disconnect but API and custom credentials can", async () => {
    state.catalogs = {
      "workspace:ws_local|pi": ["config-provider", "env-provider", "api-provider", "custom-provider"],
      "workspace:ws_local|opencode": [],
    }
    state.sources = {
      "config-provider": "config",
      "env-provider": "env",
      "api-provider": "api",
      "custom-provider": "custom",
    }
    state.connected = ["config-provider", "env-provider", "api-provider", "custom-provider"]
    mount()
    await waitFor(() => expect(providerIds("pi")).toHaveLength(4))
    for (const id of ["config-provider", "env-provider"]) {
      const row = section("pi").querySelector<HTMLElement>(`[data-provider="${id}"]`)!
      expect(within(row).queryByRole("button", { name: "common.disconnect" })).toBeNull()
    }
    for (const id of ["api-provider", "custom-provider"]) {
      const row = section("pi").querySelector<HTMLElement>(`[data-provider="${id}"]`)!
      expect(within(row).getByRole("button", { name: "common.disconnect" })).toBeInTheDocument()
    }
    const row = section("pi").querySelector<HTMLElement>('[data-provider="api-provider"]')!
    fireEvent.click(within(row).getByRole("button", { name: "common.disconnect" }))
    await waitFor(() =>
      expect(state.authDeletes).toEqual([
        "http://127.0.0.1:2593/auth/api-provider?harness=pi&directory=workspace%3Aws_local",
      ]),
    )
    expect(state.credentialDeletes).toEqual([{ providerId: "api-provider", method: "DELETE" }])
    expect(state.connected).toEqual(["config-provider", "env-provider", "custom-provider"])
    await waitFor(() => {
      const disconnected = section("pi").querySelector<HTMLElement>('[data-provider="api-provider"]')!
      expect(within(disconnected).getByRole("button", { name: "common.connect" })).toBeVisible()
      expect(within(disconnected).queryByRole("button", { name: "common.disconnect" })).toBeNull()
    })
  })

  test("the OpenCode section opens the custom-provider dialog under the selected workspace", async () => {
    mount()
    await waitFor(() => expect(providerIds("opencode")).toEqual(["external-backend"]))
    expect(section("pi").querySelector('[data-action="settings-providers-add-custom"]')).toBeNull()

    fireEvent.click(section("opencode").querySelector<HTMLElement>('[data-action="settings-providers-add-custom"]')!)

    expect(state.dialogs).toHaveLength(1)
    render(state.dialogs[0])
    expect(screen.getByTestId("custom-provider-dialog")).toHaveAttribute("data-scope", "workspace:ws_local")
  })
})

describe("Settings → Providers reports the agent logins on this machine", () => {
  test("one row per harness the local checks name, whatever the scan found", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toEqual(["anthropic", "cursor", "openai"]))
    expect(agentStatus("anthropic")).toBe("")
  })

  test("a stored credential is reported before any scan runs", async () => {
    state.storedCredentials = [{ provider_id: "claude-sdk" }]
    mount()
    await waitFor(() => expect(agentStatus("anthropic")).toBe("settings.providers.status.connected"))
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials")
    expect(state.credentialCalls).not.toContain("POST /api/claxedo/credentials/discover")
  })

  test("Detect credentials runs the machine scan and maps every row from its verdict", async () => {
    state.discoveryItems = [
      { provider_id: "claude-acp", kind: "oauth", label: "Claude Code login · ACP", origin: "keychain", probe: { state: "working" } },
      { provider_id: "claude-sdk", kind: "oauth", label: "Claude Code login · agent SDK", origin: "keychain", probe: { state: "working" } },
      { provider_id: "codex-acp", kind: "oauth", label: "Codex", origin: "config", probe: { state: "broken", reason: "token expired" } },
      { provider_id: "cursor-acp", kind: "oauth", label: "Cursor", origin: "config" },
    ]
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    fireEvent.click(detectButton())

    await waitFor(() => expect(agentStatus("anthropic")).toBe("settings.providers.status.detected"))
    expect(agentStatus("openai")).toBe("settings.providers.status.broken")
    expect(agentRow("openai").textContent).toContain("token expired")
    expect(agentStatus("cursor")).toBe("settings.providers.status.detected")
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/discover")
  })

  test("a scan that finds nothing leaves every row not connected", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    fireEvent.click(detectButton())
    await waitFor(() => expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/discover"))
    expect(["anthropic", "openai", "cursor"].map(agentStatus)).toEqual(["", "", ""])
  })

  test("Connect opens the AI-connect flow declared as a Settings port, not an inline key form", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    fireEvent.click(within(agentRow("cursor")).getByRole("button", { name: "common.connect" }))
    expect(state.dialogs).toHaveLength(1)
    render(state.dialogs[0])
    expect(screen.getByTestId("ai-connect-dialog")).toBeInTheDocument()
    expect(screen.queryByTestId("provider-connect-form")).toBeNull()
  })
})
