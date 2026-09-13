/** Native catalog transport and provider-management affordances use the real hooks. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"

const clients = new Set<QueryClient>()
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { nativeHarness, connectionHarness, type HarnessSelection } from "@/platform/identity/harness-selection"
import { readStringArray } from "@/lib/record"

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
  /** Every activate call's body, in order. */
  activated: [] as string[][],
  /** Every credential row the page asked the store to forget, in order. */
  removed: [] as string[],
  /** The provider ids each save-discovered call named, in order. */
  saved: [] as string[][],
  /** Every row whose token was replaced in place, in order. */
  reconnected: [] as string[],
  /** What a machine scan finds, as the discovery route reports it. */
  discoveryItems: [] as Array<Record<string, unknown>>,
  /** When set, the discovery route answers 500 with this cause instead of a scan. */
  discoveryFailure: undefined as string | undefined,
  credentialCalls: [] as string[],
  dialogs: [] as Array<() => JSX.Element>,
  /** What every failure told the user, in order. */
  toasts: [] as string[],
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
    saveDiscoveredAIConnections: async (input: { items: Array<{ providerId: string }> }) => {
      state.saved.push(input.items.map((item) => item.providerId))
      return input.items.map((item, index) => {
        const id = `saved_${item.providerId}`
        state.storedCredentials = [
          ...state.storedCredentials,
          { id, provider_id: item.providerId, kind: "oauth_token", label: "machine@acme.com", account_id: "acc_machine", is_active: false },
        ]
        return { credentialId: id, providerId: item.providerId, result: "ok" as const, ...(index === 0 ? {} : {}) }
      })
    },
    useServerIsLocal: () => () => true,
    useGlobalSDK: () => ({ url: "http://127.0.0.1:2593" }),
    DialogCustomProvider: (props: { scope?: string }) => (
      <div data-testid="custom-provider-dialog" data-scope={props.scope ?? ""} />
    ),
    ProviderConnectForm: (props: { onConnected?: () => void | Promise<void> }) => (
      <div data-testid="provider-connect-form">
        <button data-testid="provider-connect-save" onClick={() => void props.onConnected?.()}>Save</button>
      </div>
    ),
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
vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: (input: { title?: string; description?: string }) => {
    state.toasts.push(input.description ?? input.title ?? "")
  },
}))

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
// Kobalte's dropdown needs a real pointer stack to open; inline items keep the
// wiring behind Check now and Remove reachable.
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

/** The JSON a fetch call carried. A non-string body is not something we send. */
function requestJson(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}

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
  if (url.pathname === "/api/claxedo/credentials/activate") {
    const ids = readStringArray(requestJson(init), "ids") ?? []
    state.activated.push(ids)
    // The route marks every id and clears the mark across each id's provider.
    const providers = new Set(state.storedCredentials.filter((row) => ids.includes(String(row.id))).map((row) => row.provider_id))
    state.storedCredentials = state.storedCredentials.map((row) =>
      providers.has(row.provider_id) ? { ...row, is_active: ids.includes(String(row.id)) } : row)
    return new Response(JSON.stringify({
      credentials: state.storedCredentials.filter((row) => ids.includes(String(row.id))),
    }))
  }
  if (url.pathname === "/api/claxedo/credentials/discover") {
    if (state.discoveryFailure) {
      return new Response(JSON.stringify({
        error: {
          code: "credential_discovery_failed",
          message: "Failed to discover credentials",
          details: { detail: { name: "Error", message: state.discoveryFailure } },
        },
      }), { status: 500 })
    }
    return new Response(JSON.stringify({ discovery_id: "disc_1", items: state.discoveryItems }))
  }
  if (url.pathname.endsWith("/reconnect")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
    state.reconnected.push(id)
    state.storedCredentials = state.storedCredentials.map((row) =>
      String(row.id) === id ? { ...row, health: "ok", last_validated_at: 9 } : row)
    return new Response(JSON.stringify({ result: "ok", health: "ok", verified_at: 9 }))
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
  if (init?.method === "DELETE" && url.pathname.startsWith("/api/claxedo/credentials/")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
    state.removed.push(id)
    const gone = state.storedCredentials.find((row) => String(row.id) === id)
    state.storedCredentials = state.storedCredentials.filter((row) => String(row.id) !== id)
    // The route hands the mark to the oldest account the provider can still run on.
    if (gone?.is_active === true) {
      const heir = state.storedCredentials
        .find((row) => row.provider_id === gone.provider_id && row.health !== "auth_failed")
      if (heir) heir.is_active = true
    }
    return new Response(JSON.stringify({ deleted: gone !== undefined }))
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

function agentRow(id: string) {
  const row = section("agents").querySelector<HTMLElement>(`[data-provider="${id}"]`)
  if (!row) throw new Error(`no agent row for ${id}`)
  return row
}

/** The one sentence the harness header says about the credential it runs on. */
function agentHeader(id: string) {
  const header = agentRow(id).querySelector('[data-component="agent-header-status"]')
  return {
    sentence: header?.querySelector("span:last-child")?.textContent ?? "",
    tone: header?.querySelector('[data-component="agent-status-dot"]')?.getAttribute("data-tone") ?? "",
  }
}

/** The one action the header offers, or "" where it offers none. */
function agentAction(id: string) {
  return agentRow(id).querySelector('[data-component="provider-actions"] button')?.getAttribute("data-action") ?? ""
}

/** The entries a harness listed, by account key, in order. */
function accountIds(id: string) {
  return [...agentRow(id).querySelectorAll<HTMLElement>('[data-component="agent-account"]')]
    .map((node) => node.getAttribute("data-account") ?? "")
}

function accountRow(id: string, key: string) {
  const row = agentRow(id).querySelector<HTMLElement>(`[data-component="agent-account"][data-account="${key}"]`)
  if (!row) throw new Error(`no account entry for ${key}`)
  return row
}

/** The account key whose radio is checked, or "" when none is. */
function selectedAccount(id: string) {
  return [...agentRow(id).querySelectorAll<HTMLElement>('[data-component="agent-account"]')]
    .find((node) => node.querySelector<HTMLInputElement>('input[type="radio"]')?.checked)
    ?.getAttribute("data-account") ?? ""
}

/** The status words one entry shows after its dot, with the tone it was drawn in. */
function accountStatus(id: string, key: string) {
  const status = accountRow(id, key).querySelector('[data-component="agent-account-status"]')
  return {
    text: status?.querySelector("span:last-child")?.textContent ?? "",
    tone: status?.querySelector('[data-component="agent-status-dot"]')?.getAttribute("data-tone") ?? "",
  }
}

/**
 * One entry's Check or Remove. A lone entry is not listed, so its actions sit on
 * the harness header instead; either way there is one of each per entry.
 */
function rowAction(id: string, key: string, action: "check" | "remove" | "remove-confirm") {
  const scope = agentRow(id).querySelector<HTMLElement>(`[data-component="agent-account"][data-account="${key}"]`)
    ?? agentRow(id)
  const item = scope.querySelector<HTMLElement>(`[data-action="agent-account-${action}"]`)
  if (!item) throw new Error(`no ${action} action for ${key}`)
  return item
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
  state.toasts.length = 0
  state.storedCredentials = []
  state.activated.length = 0
  state.removed.length = 0
  state.saved.length = 0
  state.reconnected.length = 0
  state.discoveryItems = []
  state.discoveryFailure = undefined
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
  const claudeLogin = [
    { id: "sdk_work", provider_id: "claude-sdk", kind: "oauth_token", label: "work@acme.com", account_id: "acc_work", is_active: true },
    { id: "acp_work", provider_id: "claude-acp", kind: "oauth_token", label: "work@acme.com", account_id: "acc_work", is_active: true },
  ]

  test("one row per harness the local checks name, scanned without being asked", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toEqual(["anthropic", "cursor", "openai"]))
    await waitFor(() => expect(section("agents").querySelector('[data-component="agents-scanned-at"]')?.textContent)
      .toBe("settings.providers.agents.scannedNow"))
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/discover")
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials")
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials/effective")
  })

  test("Rescan runs the machine scan again", async () => {
    mount()
    await waitFor(() => expect(section("agents").querySelector('[data-action="settings-providers-rescan"]')).not.toBeNull())
    state.credentialCalls.length = 0

    section("agents").querySelector<HTMLButtonElement>('[data-action="settings-providers-rescan"]')!.click()

    await waitFor(() => expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/discover"))
  })

  test("a harness with no account and no machine login reads Not set up and offers Connect", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    await waitFor(() => expect(agentHeader("cursor").sentence).toBe("settings.providers.agents.notSetUp"))
    expect(agentHeader("cursor").tone).toBe("neutral")
    expect(agentAction("cursor")).toBe("agent-connect")
    expect(accountIds("cursor")).toEqual([])
  })

  test("a harness on a working stored account names it in the header and offers no action", async () => {
    state.storedCredentials = claudeLogin.map((row) => ({ ...row, health: "ok", last_validated_at: Date.now() }))
    mount()
    await waitFor(() => expect(agentHeader("anthropic").sentence)
      .toBe("settings.providers.agents.usingAccount:work@acme.com · settings.providers.live.ok"))
    expect(agentHeader("anthropic").tone).toBe("success")
    expect(agentAction("anthropic")).toBe("")
  })

  test("a harness on a rejected account says who rejected it and offers Reconnect on that row", async () => {
    state.storedCredentials = [
      { id: "cred_bad", provider_id: "claude-sdk", kind: "api_key", label: "Old key", is_active: true, health: "auth_failed", last_validated_at: 7 },
    ]
    mount()
    await waitFor(() => expect(agentHeader("anthropic").sentence)
      .toBe("settings.providers.agents.headerRejected:Old key|Anthropic"))
    expect(agentHeader("anthropic").tone).toBe("danger")
    expect(agentAction("anthropic")).toBe("agent-reconnect")

    agentRow("anthropic").querySelector<HTMLButtonElement>('[data-action="agent-reconnect"]')!.click()

    expect(agentRow("anthropic").querySelector('[data-component="provider-connect-card"]')?.getAttribute("data-credential"))
      .toBe("cred_bad")
  })

  test("a harness running the login on this computer says so, with the scan's verdict", async () => {
    state.discoveryItems = [{
      provider_id: "codex-app-server", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json",
      probe: { state: "working", usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }] },
    }]
    mount()
    await waitFor(() => expect(agentHeader("openai").sentence).toContain("settings.providers.agents.usingMachine"))
    expect(agentHeader("openai").sentence).toContain("settings.providers.live.ok")
    expect(agentHeader("openai").sentence).toContain("settings.providers.live.window:settings.providers.window.weekly|64")
    expect(agentHeader("openai").tone).toBe("success")
    expect(agentAction("openai")).toBe("")
  })

  test("the accounts a harness holds are one radio list, the login in use checked", async () => {
    state.storedCredentials = [
      { id: "cred_key", provider_id: "claude-sdk", kind: "api_key", label: "spare@acme.com", account_id: "fp_0123abcd…wxyz", is_active: false },
      ...claudeLogin,
    ]
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work", "cred_key"]))
    expect(selectedAccount("anthropic")).toBe("sdk_work")
    // A pasted key is named by its last characters, not by the whole fingerprint.
    expect(accountRow("anthropic", "cred_key").textContent).toContain("…wxyz")
    expect(accountRow("anthropic", "cred_key").textContent).not.toContain("fp_0123abcd")
  })

  test("a row whose only name is its provider id is listed by its fingerprint instead", async () => {
    state.storedCredentials = [
      { id: "cred_key", provider_id: "claude-sdk", kind: "api_key", label: "claude-sdk", account_id: "fp_0123abcd…wxyz", is_active: true },
      { id: "sdk_home", provider_id: "claude-sdk", kind: "oauth_token", label: "home@acme.com", account_id: "acc_home", is_active: false },
    ]
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["cred_key", "sdk_home"]))
    expect(accountRow("anthropic", "cred_key").textContent).toContain("…wxyz")
    expect(accountRow("anthropic", "cred_key").textContent).not.toContain("claude-sdk")
    expect(agentHeader("anthropic").sentence).toContain("settings.providers.agents.usingAccount:…wxyz")
  })

  test("choosing another account marks every binding of it, and the radio follows", async () => {
    state.storedCredentials = [
      ...claudeLogin,
      { id: "sdk_home", provider_id: "claude-sdk", kind: "oauth_token", label: "home@acme.com", account_id: "acc_home", is_active: false },
      { id: "acp_home", provider_id: "claude-acp", kind: "oauth_token", label: "home@acme.com", account_id: "acc_home", is_active: false },
    ]
    mount()
    await waitFor(() => expect(selectedAccount("anthropic")).toBe("sdk_work"))

    accountRow("anthropic", "sdk_home")
      .querySelector<HTMLInputElement>('input[type="radio"]')!.click()

    await waitFor(() => expect(selectedAccount("anthropic")).toBe("sdk_home"))
    // One call names both bindings, so the store can never hold the account on
    // one of them and not the other.
    expect(state.activated).toEqual([["sdk_home", "acp_home"]])
  })

  test("Codex switches accounts through the same radio list Claude does", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "work@acme.com", account_id: "acc_1", is_active: true },
      { id: "cred_codex_two", provider_id: "codex-app-server", kind: "oauth_token", label: "home@acme.com", account_id: "acc_2", is_active: false },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "cred_codex_two"]))

    accountRow("openai", "cred_codex_two")
      .querySelector<HTMLInputElement>('input[type="radio"]')!.click()

    await waitFor(() => expect(selectedAccount("openai")).toBe("cred_codex_two"))
    expect(state.activated).toEqual([["cred_codex_two"]])
  })

  test("this computer's login is listed last, even while a stored account is the one in use", async () => {
    state.storedCredentials = [...claudeLogin]
    state.discoveryItems = [{
      provider_id: "codex-app-server", kind: "oauth_token", label: "Codex", origin: "~/.codex/auth.json",
      probe: { state: "working" },
    }, {
      provider_id: "claude-sdk", kind: "oauth_token", label: "Another Claude login", account_id: "acc_other", origin: "keychain",
      probe: { state: "working" },
    }]
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work", "machine"]))
    expect(selectedAccount("anthropic")).toBe("sdk_work")
    expect(accountRow("anthropic", "machine").textContent)
      .toContain("settings.providers.agents.machineSource:keychain")
  })

  test("choosing this computer's login stores it first, then marks what was stored", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "api_key", label: "spare@acme.com", account_id: "fp_0123abcd…wxyz", is_active: true },
    ]
    state.discoveryItems = [{
      provider_id: "codex-app-server", kind: "oauth_token", label: "Codex", account_id: "acc_machine", origin: "~/.codex/auth.json",
      probe: { state: "working" },
    }]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "machine"]))
    expect(selectedAccount("openai")).toBe("cred_codex")

    accountRow("openai", "machine")
      .querySelector<HTMLInputElement>('input[type="radio"]')!.click()

    await waitFor(() => expect(state.saved).toEqual([["codex-app-server"]]))
    // Saving alone would leave the harness on whatever it ran on before.
    expect(state.activated).toEqual([["saved_codex-app-server"]])
  })

  test("Check asks the provider and rewrites that entry's status", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "work@acme.com", is_active: true },
      { id: "cred_codex_two", provider_id: "codex-app-server", kind: "oauth_token", label: "home@acme.com", account_id: "acc_2", is_active: false },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "cred_codex_two"]))
    expect(accountStatus("openai", "cred_codex").text).toBe("settings.providers.agents.unchecked")

    rowAction("openai", "cred_codex", "check").click()

    await waitFor(() => expect(accountStatus("openai", "cred_codex").text).toContain("settings.providers.live.ok"))
    const status = accountStatus("openai", "cred_codex")
    expect(status.text).toContain("settings.providers.live.checkedNow")
    expect(status.tone).toBe("success")
    expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/cred_codex/verify")
  })

  test("Remove asks, then forgets every binding of the account", async () => {
    state.storedCredentials = [
      ...claudeLogin,
      { id: "sdk_home", provider_id: "claude-sdk", kind: "oauth_token", label: "home@acme.com", account_id: "acc_home", is_active: false },
      { id: "acp_home", provider_id: "claude-acp", kind: "oauth_token", label: "home@acme.com", account_id: "acc_home", is_active: false },
    ]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work", "sdk_home"]))

    rowAction("anthropic", "sdk_home", "remove").click()
    expect(state.removed).toEqual([])

    rowAction("anthropic", "sdk_home", "remove-confirm").click()

    // One entry left is one the header sentence names, so the list goes away.
    await waitFor(() => expect(accountIds("anthropic")).toEqual([]))
    expect(agentHeader("anthropic").sentence)
      .toBe("settings.providers.agents.usingAccount:work@acme.com · settings.providers.agents.unchecked")
    expect(state.removed).toEqual(["sdk_home", "acp_home"])
  })

  test("removing the account in use moves the radio to the row the server promoted", async () => {
    state.storedCredentials = [
      ...claudeLogin,
      { id: "sdk_home", provider_id: "claude-sdk", kind: "oauth_token", label: "home@acme.com", account_id: "acc_home", is_active: false },
      { id: "sdk_spare", provider_id: "claude-sdk", kind: "api_key", label: "spare@acme.com", account_id: "acc_spare", is_active: false },
    ]
    mount()
    await waitFor(() => expect(selectedAccount("anthropic")).toBe("sdk_work"))

    rowAction("anthropic", "sdk_work", "remove").click()
    rowAction("anthropic", "sdk_work", "remove-confirm").click()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_home", "sdk_spare"]))
    expect(selectedAccount("anthropic")).toBe("sdk_home")
  })

  test("removing the last account, which the header names rather than lists, returns the harness to Not set up", async () => {
    state.storedCredentials = [
      { id: "cred_token", provider_id: "claude-sdk", kind: "oauth_token", label: "work@acme.com", is_active: true },
    ]
    mount()
    await waitFor(() => expect(agentHeader("anthropic").sentence)
      .toContain("settings.providers.agents.usingAccount:work@acme.com"))
    expect(accountIds("anthropic")).toEqual([])

    rowAction("anthropic", "cred_token", "remove").click()
    rowAction("anthropic", "cred_token", "remove-confirm").click()

    await waitFor(() => expect(agentHeader("anthropic").sentence).toBe("settings.providers.agents.notSetUp"))
    expect(agentAction("anthropic")).toBe("agent-connect")
  })

  test("Add an account opens the connect card with no row named, and saving rescans", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    expect(agentRow("cursor").querySelector('[data-component="provider-connect-card"]')).toBeNull()

    agentRow("cursor").querySelector<HTMLButtonElement>('[data-action="agent-add-account"]')!.click()

    const card = agentRow("cursor").querySelector('[data-component="provider-connect-card"]')
    expect(card?.getAttribute("data-credential")).toBeNull()
    expect(card?.textContent).toContain("settings.providers.connect.title:Cursor")
    state.credentialCalls.length = 0

    within(agentRow("cursor")).getByTestId("provider-connect-save").click()

    await waitFor(() => expect(state.credentialCalls).toContain("POST /api/claxedo/credentials/discover"))
  })

  test("a scan that fails tells the user what broke, not that a scan failed", async () => {
    state.discoveryFailure = "User agent config contains invalid JSON"
    mount()

    await waitFor(() => expect(state.toasts).toEqual(["User agent config contains invalid JSON"]))
  })
})
