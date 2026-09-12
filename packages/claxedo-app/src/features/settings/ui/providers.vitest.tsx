/** Native catalog transport and provider-management affordances use the real hooks. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"

const clients = new Set<QueryClient>()
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { nativeHarness, connectionHarness, type HarnessSelection } from "@/platform/identity/harness-selection"

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
  /** The workspace the pane behind Settings is on, when Settings opened over one. */
  focusedWorkspace: undefined as { workspaceId: string; directory: string } | undefined,
  projects: [] as CatalogProject[],
  /** What the credential store already holds, as the list route reports it. */
  storedCredentials: [] as Array<Record<string, unknown>>,
  /** Every account id activate was called for, in order. */
  activated: [] as string[],
  /** Account ids the activate route refuses. */
  activateFails: [] as string[],
  /** What a machine scan finds, as the discovery route reports it. */
  discoveryItems: [] as Array<Record<string, unknown>>,
  credentialCalls: [] as string[],
  dialogs: [] as Array<() => JSX.Element>,
}))

vi.mock("@/features/settings/app-ports", async () => {
  const { useProviders } = await import("@/app/providers/use-providers")
  const { discoverAIConnections, verifyAIConnection } = await import("@/features/onboarding/ai-connect-api")
  const { groupDiscoveryItems, localHarnessChecks, localHarnessStatuses } = await import(
    "@/features/onboarding/ai-connect-state"
  )
  return {
    useProviders,
    discoverAIConnections,
    verifyAIConnection,
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
      if (!state.focusedWorkspace) throw new Error("no workspace SDK scope")
      return state.focusedWorkspace
    },
    useEnabledAcpHarnesses: () => () => [
      { key: "team-agent", label: "Team Agent" },
      { key: "opencode", label: "External OpenCode" },
      { key: "pi", label: "External Pi" },
    ],
    saveDiscoveredAIConnections: async () => [],
    useServerIsLocal: () => () => true,
    useGlobalSDK: () => ({ url: "http://127.0.0.1:2593" }),
    DialogCustomProvider: (props: { scope?: string }) => (
      <div data-testid="custom-provider-dialog" data-scope={props.scope ?? ""} />
    ),
    ProviderConnectForm: () => <div data-testid="provider-connect-form" />,
  }
})

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => {
    if (!state.focusedWorkspace) throw new Error("no focused workspace")
    return state.focusedWorkspace
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
  if (url.pathname === "/api/claxedo/credentials/effective") {
    return new Response(JSON.stringify({
      scope: "local",
      credentials: state.storedCredentials.filter((row) => row.is_active !== false),
    }))
  }
  if (url.pathname.endsWith("/activate")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
    state.activated.push(id)
    if (state.activateFails.includes(id)) {
      return new Response(JSON.stringify({ error: { code: "credential_not_activatable", message: "refused" } }), { status: 409 })
    }
    // The route marks one row and clears the mark for that row's provider only.
    const target = state.storedCredentials.find((row) => row.id === id)
    state.storedCredentials = state.storedCredentials.map((row) =>
      row.provider_id === target?.provider_id ? { ...row, is_active: row.id === id } : row)
    return new Response(JSON.stringify({ credential: state.storedCredentials.find((row) => row.id === id) }))
  }
  if (url.pathname === "/api/claxedo/credentials/discover") {
    return new Response(JSON.stringify({ discovery_id: "disc_1", items: state.discoveryItems }))
  }
  if (url.pathname.endsWith("/verify")) {
    return new Response(JSON.stringify({
      result: "ok",
      health: "ok",
      verified_at: 7,
      usage: [{ window: "session", usedPercent: 12, resetsAt: null }, { window: "weekly", usedPercent: 40, resetsAt: null }],
    }))
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

function newClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  return client
}

function mount(client = newClient()) {
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

/** The stored accounts a harness row listed, by credential id. */
function accountIds(id: string) {
  return [...agentRow(id).querySelectorAll<HTMLElement>('[data-component="provider-account"]')]
    .map((node) => node.getAttribute("data-account") ?? "")
}

function accountRow(id: string, credentialId: string) {
  const row = agentRow(id).querySelector<HTMLElement>(`[data-account="${credentialId}"]`)
  if (!row) throw new Error(`no account row for ${credentialId}`)
  return row
}

beforeEach(() => {
  state.requests.length = 0
  state.rememberedHarness = nativeHarness("pi")
  state.focusedWorkspace = undefined
  state.connected = []
  state.sources = {}
  state.credentialDeletes.length = 0
  state.authDeletes.length = 0
  state.authReads.length = 0
  state.credentialCalls.length = 0
  state.dialogs.length = 0
  state.storedCredentials = []
  state.activated.length = 0
  state.activateFails.length = 0
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

describe("Settings → Providers reads both credential stores for the workspace in view", () => {
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

  test("both credential stores are read for the workspace the pane behind Settings is on", async () => {
    state.focusedWorkspace = { workspaceId: "ws_cloud", directory: "/workspace" }
    mount()
    await waitFor(() => expect(providerIds("pi")).toEqual(["cloud-backend"]))
    expect(providerIds("opencode")).toEqual(["cloud-opencode"])
    expect([...state.requests].sort((a, b) => a.harness.localeCompare(b.harness))).toEqual([
      { scope: "workspace:ws_cloud", harness: "opencode" },
      { scope: "workspace:ws_cloud", harness: "pi" },
    ])
  })

  test.each([
    ["a harness that manages its own credentials", nativeHarness("claude")],
    ["another such harness", nativeHarness("cursor")],
    ["an operator ACP connection", connectionHarness("team-agent")],
    ["nothing at all", undefined],
  ] as const)("with %s remembered, both Claxedo stores render and neither is read under it", async (_label, remembered) => {
    state.rememberedHarness = remembered
    mount()
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
    expect(providerIds("opencode")).toEqual(["external-backend"])
    expect([...state.requests].map((request) => request.harness).sort()).toEqual(["opencode", "pi"])
  })

  test("the page offers no scope picker and no externally-managed note", async () => {
    state.rememberedHarness = nativeHarness("claude")
    mount()
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
    expect(document.querySelector('[data-component="settings-scope-selector"]')).toBeNull()
    expect(document.querySelector('[data-component="providers-externally-managed"]')).toBeNull()
  })

  test("catalog caches stay isolated when the page reopens on another workspace", async () => {
    const client = newClient()
    state.focusedWorkspace = { workspaceId: "ws_local", directory: "/repo" }
    mount(client)
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))

    cleanup()
    state.focusedWorkspace = { workspaceId: "ws_cloud", directory: "/workspace" }
    mount(client)
    await waitFor(() => expect(providerIds("pi")).toEqual(["cloud-backend"]))
    expect(providerIds("opencode")).toEqual(["cloud-opencode"])

    cleanup()
    state.focusedWorkspace = { workspaceId: "ws_local", directory: "/repo" }
    mount(client)
    await waitFor(() => expect(providerIds("pi")).toEqual(["anthropic", "openai"]))
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

  test("the OpenCode section opens the custom-provider dialog under the workspace in view", async () => {
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
    state.storedCredentials = [{ id: "cred_claude", provider_id: "claude-sdk", is_active: true }]
    mount()
    await waitFor(() => expect(agentStatus("anthropic")).toBe("settings.providers.status.connected"))
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials")
    expect(state.credentialCalls).not.toContain("POST /api/claxedo/credentials/discover")
  })

  test("Detect credentials runs the machine scan and maps every row from its verdict", async () => {
    state.discoveryItems = [
      { provider_id: "claude-acp", kind: "oauth", label: "Claude Code login · ACP", origin: "keychain", probe: { state: "working" } },
      { provider_id: "claude-sdk", kind: "oauth", label: "Claude Code login · agent SDK", origin: "keychain", probe: { state: "working" } },
      { provider_id: "codex-app-server", kind: "oauth", label: "Codex", origin: "config", probe: { state: "broken", reason: "token expired" } },
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

  test("each harness row says which credential it runs on: the stored row, else this computer's login", async () => {
    state.storedCredentials = [{ id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "ChatGPT OAuth" }]
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    await waitFor(() => expect(agentRow("openai").querySelector('[data-component="provider-in-use"]')?.textContent).toBe("settings.providers.agents.inUse:ChatGPT OAuth"))
    expect(agentRow("anthropic").querySelector('[data-component="provider-in-use"]')?.textContent).toBe("settings.providers.agents.inUseMachine")
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials/effective")
  })

  test("Check on a harness with a stored row asks the provider and shows its verdict with the plan's windows", async () => {
    state.storedCredentials = [{ id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "ChatGPT OAuth" }]
    mount()
    await waitFor(() => expect(agentRow("openai").querySelector('[data-component="provider-in-use"]')).not.toBeNull())
    expect(agentRow("openai").querySelector('[data-component="provider-live"]')).toBeNull()

    agentRow("openai").querySelector<HTMLButtonElement>('[data-action="settings-provider-check"]')!.click()

    await waitFor(() => expect(agentRow("openai").querySelector('[data-component="provider-live"]')).not.toBeNull())
    const live = agentRow("openai").querySelector('[data-component="provider-live"]')!.textContent ?? ""
    expect(live).toContain("settings.providers.live.ok")
    expect(live).toContain("settings.providers.live.window:settings.providers.window.session|12")
    expect(live).toContain("settings.providers.live.window:settings.providers.window.weekly|40")
    expect(live).toContain("settings.providers.live.checkedNow")
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/cred_codex/verify")
  })

  test("Check on a harness running the machine login re-scans, and the row reads the scan's verdict", async () => {
    state.discoveryItems = [{
      provider_id: "codex-app-server", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json",
      probe: { state: "working", usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }] },
    }]
    mount()
    await waitFor(() => expect(agentRow("openai").querySelector('[data-component="provider-in-use"]')).not.toBeNull())

    agentRow("openai").querySelector<HTMLButtonElement>('[data-action="settings-provider-check"]')!.click()

    await waitFor(() => expect(agentRow("openai").querySelector('[data-component="provider-live"]')).not.toBeNull())
    const live = agentRow("openai").querySelector('[data-component="provider-live"]')!.textContent ?? ""
    expect(live).toContain("settings.providers.live.ok")
    expect(live).toContain("settings.providers.live.window:settings.providers.window.weekly|64")
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/discover")
    expect(state.credentialCalls.some((call) => call.endsWith("/verify"))).toBe(false)
  })

  test("Connect opens an inset card in the row, named for the harness, that its own close button dismisses", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    fireEvent.click(within(agentRow("cursor")).getByRole("button", { name: "common.connect" }))
    const card = agentRow("cursor").querySelector('[data-component="provider-connect-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain("settings.providers.connect.title:Cursor")
    expect(within(agentRow("cursor")).getByTestId("provider-connect-form")).toBeInTheDocument()
    // While open, the row offers no second Connect and no dialog is involved.
    expect(within(agentRow("cursor")).queryByRole("button", { name: "common.connect" })).toBeNull()
    expect(state.dialogs).toHaveLength(0)
    fireEvent.click(within(agentRow("cursor")).getByRole("button", { name: "common.close" }))
    expect(agentRow("cursor").querySelector('[data-component="provider-connect-card"]')).toBeNull()
    expect(within(agentRow("cursor")).getByRole("button", { name: "common.connect" })).toBeInTheDocument()
  })

  test("the accounts a harness holds are listed under its row, active first", async () => {
    state.storedCredentials = [
      { id: "cred_key", provider_id: "claude-sdk", kind: "api_key", label: "API key", account_id: "fp_0123abcd…wxyz", is_active: false, expires_at: 4102444800000 },
      { id: "cred_token", provider_id: "claude-sdk", kind: "oauth_token", label: "Subscription", is_active: true, health: "ok", last_validated_at: 7 },
    ]
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["cred_token", "cred_key"]))
    const active = accountRow("anthropic", "cred_token")
    expect(active.getAttribute("data-active")).toBe("true")
    expect(active.textContent).toContain("Subscription")
    expect(active.textContent).toContain("settings.providers.agents.accountActive")
    expect(active.querySelector('[data-action="settings-provider-activate"]')).toBeNull()

    const inactive = accountRow("anthropic", "cred_key")
    expect(inactive.getAttribute("data-active")).toBe("false")
    // A pasted key is named by its last characters, not by the whole fingerprint.
    expect(inactive.textContent).toContain("…wxyz")
    expect(inactive.textContent).not.toContain("fp_0123abcd")
    expect(inactive.textContent).toContain("settings.providers.agents.accountExpires")
    expect(inactive.querySelector('[data-action="settings-provider-activate"]')).not.toBeNull()
  })

  test("Make active switches the account and the In use line names the new one", async () => {
    state.storedCredentials = [
      { id: "cred_key", provider_id: "claude-sdk", kind: "api_key", label: "API key", account_id: "fp_0123abcd…wxyz", is_active: false, expires_at: 4102444800000 },
      { id: "cred_token", provider_id: "claude-sdk", kind: "oauth_token", label: "Subscription", is_active: true, health: "ok", last_validated_at: 7 },
    ]
    mount()
    await waitFor(() => expect(agentRow("anthropic").querySelector('[data-component="provider-in-use"]')?.textContent)
      .toBe("settings.providers.agents.inUse:Subscription"))

    accountRow("anthropic", "cred_key").querySelector<HTMLButtonElement>('[data-action="settings-provider-activate"]')!.click()

    await waitFor(() => expect(state.activated).toEqual(["cred_key"]))
    await waitFor(() => expect(agentRow("anthropic").querySelector('[data-component="provider-in-use"]')?.textContent)
      .toBe("settings.providers.agents.inUse:API key"))
    expect(accountRow("anthropic", "cred_key").getAttribute("data-active")).toBe("true")
    expect(accountRow("anthropic", "cred_token").getAttribute("data-active")).toBe("false")
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/cred_key/activate")
  })

  test("Add account opens the same inline connect card the Connect button opens", async () => {
    state.storedCredentials = [
      { id: "cred_key", provider_id: "claude-sdk", kind: "api_key", label: "API key", account_id: "fp_0123abcd…wxyz", is_active: false, expires_at: 4102444800000 },
      { id: "cred_token", provider_id: "claude-sdk", kind: "oauth_token", label: "Subscription", is_active: true, health: "ok", last_validated_at: 7 },
    ]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toHaveLength(2))
    expect(agentRow("anthropic").querySelector('[data-component="provider-connect-card"]')).toBeNull()

    agentRow("anthropic").querySelector<HTMLButtonElement>('[data-action="settings-provider-add-account"]')!.click()

    const card = agentRow("anthropic").querySelector('[data-component="provider-connect-card"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain("settings.providers.connect.title:Claude Code")
    expect(within(agentRow("anthropic")).getByTestId("provider-connect-form")).toBeInTheDocument()
  })

  test("Codex lists its accounts but offers no switch yet, and says so", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "ChatGPT OAuth", account_id: "acc_1", is_active: true },
      { id: "cred_codex_two", provider_id: "codex-app-server", kind: "oauth_token", label: "Second ChatGPT", account_id: "acc_2", is_active: false },
    ]
    mount()

    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "cred_codex_two"]))
    expect(accountRow("openai", "cred_codex").textContent).toContain("settings.providers.agents.accountActive")
    expect(agentRow("openai").querySelector('[data-action="settings-provider-activate"]')).toBeNull()
    expect(agentRow("openai").querySelector('[data-component="provider-activate-note"]')?.textContent)
      .toBe("settings.providers.agents.switchLater")
  })

  test("a login saved under both bindings is one account, keyed by the connect provider's row", async () => {
    state.storedCredentials = [
      { id: "acp_old", provider_id: "claude-acp", kind: "oauth_token", label: "Work login", account_id: "acc_work", is_active: true },
      { id: "sdk_old", provider_id: "claude-sdk", kind: "oauth_token", label: "Work login", account_id: "acc_work", is_active: true },
      { id: "acp_new", provider_id: "claude-acp", kind: "oauth_token", label: "Personal login", account_id: "acc_personal", is_active: false },
      { id: "sdk_new", provider_id: "claude-sdk", kind: "oauth_token", label: "Personal login", account_id: "acc_personal", is_active: false },
    ]
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_old", "sdk_new"]))
    expect(accountRow("anthropic", "sdk_old").getAttribute("data-active")).toBe("true")
    expect(accountRow("anthropic", "sdk_new").getAttribute("data-active")).toBe("false")
  })

  test("Make active marks every binding of the account it was clicked on", async () => {
    state.storedCredentials = [
      { id: "acp_old", provider_id: "claude-acp", kind: "oauth_token", label: "Work login", account_id: "acc_work", is_active: true },
      { id: "sdk_old", provider_id: "claude-sdk", kind: "oauth_token", label: "Work login", account_id: "acc_work", is_active: true },
      { id: "acp_new", provider_id: "claude-acp", kind: "oauth_token", label: "Personal login", account_id: "acc_personal", is_active: false },
      { id: "sdk_new", provider_id: "claude-sdk", kind: "oauth_token", label: "Personal login", account_id: "acc_personal", is_active: false },
    ]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toHaveLength(2))

    accountRow("anthropic", "sdk_new").querySelector<HTMLButtonElement>('[data-action="settings-provider-activate"]')!.click()

    await waitFor(() => expect(accountRow("anthropic", "sdk_new").getAttribute("data-active")).toBe("true"))
    expect(state.activated).toEqual(["sdk_new", "acp_new"])
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/sdk_new/activate")
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/acp_new/activate")
    expect(accountRow("anthropic", "sdk_old").getAttribute("data-active")).toBe("false")
  })

  test("a switch that half-lands leaves the account reading as not active", async () => {
    state.storedCredentials = [
      { id: "acp_old", provider_id: "claude-acp", kind: "oauth_token", label: "Work login", account_id: "acc_work", is_active: true },
      { id: "sdk_old", provider_id: "claude-sdk", kind: "oauth_token", label: "Work login", account_id: "acc_work", is_active: true },
      { id: "acp_new", provider_id: "claude-acp", kind: "oauth_token", label: "Personal login", account_id: "acc_personal", is_active: false },
      { id: "sdk_new", provider_id: "claude-sdk", kind: "oauth_token", label: "Personal login", account_id: "acc_personal", is_active: false },
    ]
    state.activateFails = ["acp_new"]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toHaveLength(2))

    accountRow("anthropic", "sdk_new").querySelector<HTMLButtonElement>('[data-action="settings-provider-activate"]')!.click()

    await waitFor(() => expect(state.activated).toEqual(["sdk_new", "acp_new"]))
    // The SDK binding moved, the ACP binding was refused: neither account has
    // every binding, so neither claims the tag.
    await waitFor(() => expect(accountRow("anthropic", "sdk_new").getAttribute("data-active")).toBe("false"))
    expect(accountRow("anthropic", "sdk_old").getAttribute("data-active")).toBe("false")
  })
})
