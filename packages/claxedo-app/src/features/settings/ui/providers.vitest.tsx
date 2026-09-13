/** Native catalog transport and provider-management affordances use the real hooks. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"

const clients = new Set<QueryClient>()
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal, type JSX } from "solid-js"
import { harnessBindingIds, HARNESS_TABLE } from "@claxedo/agent-runtime-contract"
import { nativeHarness, connectionHarness, type HarnessSelection } from "@/platform/identity/harness-selection"
import { readField, readStringArray } from "@/lib/record"

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
  /** The provider ids each machine-login activation named, in order. */
  machineActivated: [] as string[][],
  /** Every row whose token was replaced in place, in order. */
  reconnected: [] as string[],
  /** What each harness on this machine says about its own login. */
  machineLogins: [] as Array<Record<string, unknown>>,
  /** When set, the machine-login route answers 500 with this cause instead. */
  machineLoginFailure: undefined as string | undefined,
  /** When set, the verify route answers 500 with this cause instead. */
  verifyFailure: undefined as string | undefined,
  /** When set, the machine-login route waits on it, so the first read can be held open. */
  machineLoginGate: undefined as Promise<void> | undefined,
  credentialCalls: [] as string[],
  dialogs: [] as Array<() => JSX.Element>,
  /** What every failure told the user, in order. */
  toasts: [] as string[],
}))

vi.mock("@/features/settings/app-ports", async () => {
  const { useProviders } = await import("@/app/providers/use-providers")
  const { loadMachineLogins, useMachineLogin, verifyAIConnection } = await import("@/features/onboarding/ai-connect-api")
  const { localHarnessChecks } = await import("@/features/onboarding/ai-connect-state")
  return {
    useProviders,
    verifyAIConnection,
    loadMachineLogins,
    useMachineLogin,
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
const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})
globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  state.credentialCalls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`)
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
    const body = requestJson(init)
    const machine = readStringArray(readField(body, "machine_login"), "provider_ids")
    if (machine) {
      state.machineActivated.push(machine)
      state.storedCredentials = state.storedCredentials.map((row) =>
        machine.includes(String(row.provider_id)) ? { ...row, is_active: false } : row)
      return new Response(JSON.stringify({ credentials: [], cleared: [] }))
    }
    const ids = readStringArray(body, "ids") ?? []
    state.activated.push(ids)
    // The route marks every id and clears the mark across each id's provider.
    const providers = new Set(state.storedCredentials.filter((row) => ids.includes(String(row.id))).map((row) => row.provider_id))
    state.storedCredentials = state.storedCredentials.map((row) =>
      providers.has(row.provider_id) ? { ...row, is_active: ids.includes(String(row.id)) } : row)
    return new Response(JSON.stringify({
      credentials: state.storedCredentials.filter((row) => ids.includes(String(row.id))),
    }))
  }
  if (url.pathname === "/api/claxedo/credentials/machine-logins") {
    if (state.machineLoginGate) await state.machineLoginGate
    if (state.machineLoginFailure) {
      return new Response(JSON.stringify({
        error: {
          code: "credential_machine_login_failed",
          message: "Failed to read this computer's logins",
          details: { detail: { name: "Error", message: state.machineLoginFailure } },
        },
      }), { status: 500 })
    }
    const asked = url.searchParams.get("harness")
    return new Response(JSON.stringify({
      machine_logins: state.machineLogins.filter((login) => asked === null || login.harness === asked),
    }))
  }
  if (url.pathname.endsWith("/reconnect")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
    state.reconnected.push(id)
    state.storedCredentials = state.storedCredentials.map((row) =>
      String(row.id) === id ? { ...row, health: "ok", last_validated_at: 9 } : row)
    return new Response(JSON.stringify({ result: "ok", health: "ok", verified_at: 9 }))
  }
  if (url.pathname.endsWith("/verify")) {
    if (state.verifyFailure) {
      return new Response(JSON.stringify({
        error: {
          code: "credential_verify_failed",
          message: "Failed to verify the credential",
          details: { detail: { name: "Error", message: state.verifyFailure } },
        },
      }), { status: 500 })
    }
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

/** The second line of one entry — its usage, and where it came from. */
function accountDetail(id: string, key: string) {
  return accountRow(id, key).querySelector('[data-slot="radio-list-item-description"]')?.textContent ?? ""
}

/** When the figures on the row were read, which sits in the row's right-hand column. */
function accountChecked(id: string, key: string) {
  return accountRow(id, key).querySelector('[data-component="agent-account-checked"]')?.textContent ?? ""
}

/** The sentence behind the hint beside the label, or "" where the row offers none. */
function accountNote(id: string, key: string) {
  return accountRow(id, key)
    .querySelector('[data-component="agent-account-note"] [aria-label]')
    ?.getAttribute("aria-label") ?? ""
}

/** The places the entry marks a turn on it can run in. */
function accountReachIcons(id: string, key: string) {
  const group = accountRow(id, key).querySelector('[data-component="agent-account-reach"] [data-reach]')
  return [...group?.querySelectorAll("[data-icon]") ?? []].map((icon) => icon.getAttribute("data-icon"))
}

/** Whether the entry's radio is ringed for a provider refusal. */
function accountRefused(id: string, key: string) {
  return accountRow(id, key).hasAttribute("data-invalid")
}

function rowAction(id: string, key: string, action: "check" | "remove" | "remove-confirm") {
  const item = accountRow(id, key).querySelector<HTMLElement>(`[data-action="agent-account-${action}"]`)
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
  state.machineActivated.length = 0
  state.reconnected.length = 0
  state.machineLogins = []
  state.machineLoginFailure = undefined
  state.machineLoginGate = undefined
  state.verifyFailure = undefined
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
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials/machine-logins")
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials")
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials/effective")
  })

  test("the section is a loader until its first read comes back, and the rows arrive once", async () => {
    state.storedCredentials = [...claudeLogin]
    state.machineLogins = [{
      harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_in", email: "machine@acme.com",
    }]
    let open = () => {}
    state.machineLoginGate = new Promise<void>((resolve) => { open = resolve })
    // Every set of account keys the section ever painted, so a first frame that
    // differs from the answer is visible rather than merely improbable.
    const painted: string[] = []
    const observer = new MutationObserver(() => {
      const keys = [...document.querySelectorAll<HTMLElement>('[data-component="agents-providers-section"] [data-component="agent-account"]')]
        .map((node) => node.getAttribute("data-account") ?? "").join(",")
      if (keys && painted.at(-1) !== keys) painted.push(keys)
    })
    mount()
    observer.observe(document.body, { childList: true, subtree: true })

    await waitFor(() => expect(section("agents").querySelector('[data-component="agents-scanning"]')).not.toBeNull())
    expect(providerIds("agents")).toEqual([])
    expect(section("agents").querySelector('[data-component="agents-scanned-at"]')?.textContent)
      .toBe("settings.providers.agents.scanning")

    open()

    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    observer.disconnect()
    expect(section("agents").querySelector('[data-component="agents-scanning"]')).toBeNull()
    expect(accountIds("anthropic")).toEqual(["sdk_work"])
    expect(accountIds("openai")).toEqual(["machine"])
    // One painted row set, and it is the answer.
    expect([...new Set(painted)]).toEqual(["sdk_work,machine"])
  })

  test("Rescan runs under the rows, which stay on screen while it does", async () => {
    state.storedCredentials = [...claudeLogin]
    mount()
    await waitFor(() => expect(section("agents").querySelector('[data-action="settings-providers-rescan"]')).not.toBeNull())
    state.credentialCalls.length = 0
    let open = () => {}
    state.machineLoginGate = new Promise<void>((resolve) => { open = resolve })

    section("agents").querySelector<HTMLButtonElement>('[data-action="settings-providers-rescan"]')!.click()

    await waitFor(() => expect(section("agents").querySelector('[data-component="agents-scanned-at"]')?.textContent)
      .toBe("settings.providers.agents.rescanning"))
    // Inline, not a loader: the answer already on screen is not taken away to
    // ask the same question again.
    expect(section("agents").querySelector('[data-component="agents-scanning"]')).toBeNull()
    expect(accountIds("anthropic")).toEqual(["sdk_work"])

    open()

    await waitFor(() => expect(section("agents").querySelector('[data-component="agents-scanned-at"]')?.textContent)
      .toBe("settings.providers.agents.scannedNow"))
    expect(state.credentialCalls).toContain("GET /api/claxedo/credentials/machine-logins")
  })

  test("a harness with no account and no machine login lists nothing and offers Connect", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    expect(agentAction("cursor")).toBe("agent-add-account")
    expect(accountIds("cursor")).toEqual([])
    // The header is the name and the one button, and says nothing else.
    expect(agentRow("cursor").querySelector("div")?.textContent)
      .toBe("Cursorsettings.providers.agents.addAccount")
  })

  test("a harness on a working stored account offers only Add an account, and the row carries the check", async () => {
    state.storedCredentials = claudeLogin.map((row) => ({ ...row, health: "ok", last_validated_at: Date.now() }))
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work"]))
    expect(agentAction("anthropic")).toBe("agent-add-account")
    expect(accountRefused("anthropic", "sdk_work")).toBe(false)
    expect(accountChecked("anthropic", "sdk_work")).toBe("common.justNow")
    expect(accountRow("anthropic", "sdk_work").textContent).toContain("work@acme.com")
  })

  test("a stored account shows the usage the server holds, before anything here has asked", async () => {
    state.storedCredentials = claudeLogin.map((row) => ({
      ...row,
      health: "ok",
      last_validated_at: Date.now() - 2 * 60 * 60_000,
      usage_windows: [
        { window: "session", usedPercent: 23.4491, resetsAt: null },
        { window: "weekly", usedPercent: 66.5, resetsAt: null },
      ],
      usage_at: Date.now() - 5 * 60_000,
    }))
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work"]))
    // Two ages in the row, and the vendor's fraction of a percent is not one of
    // the figures: the line carries what the reader acts on, at whole percent.
    expect(accountDetail("anthropic", "sdk_work")).toBe([
      "acc_work",
      "settings.providers.live.ok",
      "settings.providers.live.window:settings.providers.window.session|23",
      "settings.providers.live.window:settings.providers.window.weekly|67",
    ].join(" · "))
    // The read's age leaves the sentence for the column every row lines up in.
    expect(accountChecked("anthropic", "sdk_work")).toBe("5m")
    expect(state.credentialCalls).not.toContain("POST /api/claxedo/credentials/sdk_work/verify")
  })

  test("Check puts fresh windows over the ones the server had stored", async () => {
    state.storedCredentials = claudeLogin.map((row) => ({
      ...row,
      usage_windows: [{ window: "session", usedPercent: 23, resetsAt: null }],
      usage_at: Date.now() - 5 * 60_000,
    }))
    mount()
    await waitFor(() => expect(accountDetail("anthropic", "sdk_work"))
      .toContain("settings.providers.live.window:settings.providers.window.session|23"))

    rowAction("anthropic", "sdk_work", "check").click()

    await waitFor(() => expect(accountDetail("anthropic", "sdk_work")).toBe([
      "acc_work",
      "settings.providers.live.ok",
      "settings.providers.live.window:settings.providers.window.session|12",
      "settings.providers.live.window:settings.providers.window.weekly|40",
    ].join(" · ")))
    expect(accountChecked("anthropic", "sdk_work")).toBe("common.justNow")
  })

  test("a check the provider never answered says so, and is not a refusal", async () => {
    state.verifyFailure = "fetch failed"
    state.storedCredentials = [...claudeLogin]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work"]))

    rowAction("anthropic", "sdk_work", "check").click()

    await waitFor(() => expect(accountDetail("anthropic", "sdk_work"))
      .toBe(["acc_work", "settings.providers.live.unknown", "fetch failed"].join(" · ")))
    // The row was read, so it carries the age — which is the whole of what it
    // said before, and reads as a check that landed.
    expect(accountChecked("anthropic", "sdk_work")).toBe("common.justNow")
    // Nothing about the stored token changed, so nothing rings and no Reconnect
    // is offered for it.
    expect(accountRefused("anthropic", "sdk_work")).toBe(false)
    expect(accountRow("anthropic", "sdk_work").querySelector('[data-action="agent-reconnect"]')).toBeNull()
  })

  test("a rejected account rings its own radio and moves the action to Reconnect", async () => {
    state.storedCredentials = [
      { id: "cred_bad", provider_id: "claude-sdk", kind: "api_key", label: "Old key", is_active: true, health: "auth_failed", last_validated_at: 7 },
    ]
    mount()
    await waitFor(() => expect(accountRefused("anthropic", "cred_bad")).toBe(true))
    // The header says nothing about it; the failing row carries its own repair.
    expect(agentAction("anthropic")).toBe("agent-add-account")
    expect(accountRow("anthropic", "cred_bad").querySelector('[data-component="agent-account-refusal"]')?.textContent)
      .toBe("settings.providers.live.authFailed")
    expect(accountRow("anthropic", "cred_bad").querySelector('[data-action="agent-account-remove"]')).not.toBeNull()

    accountRow("anthropic", "cred_bad").querySelector<HTMLButtonElement>('[data-action="agent-reconnect"]')!.click()

    expect(agentRow("anthropic").querySelector('[data-component="provider-connect-card"]')?.getAttribute("data-credential"))
      .toBe("cred_bad")
  })

  test("this computer's Codex login is named by its address and carries the usage the harness reported", async () => {
    state.machineLogins = [{
      harness: "codex",
      providerIds: ["codex-app-server", "openai"],
      state: "signed_in",
      email: "machine@acme.com",
      plan: "pro",
      usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }],
    }]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["machine"]))
    expect(accountRow("openai", "machine").textContent).toContain("machine@acme.com")
    expect(accountDetail("openai", "machine"))
      .toBe("settings.providers.live.window:settings.providers.window.weekly|64")
    expect(selectedAccount("openai")).toBe("machine")
    expect(agentAction("openai")).toBe("agent-add-account")
  })

  test("windows the server answered from stored state say how old they are, as a stored account does", async () => {
    state.machineLogins = [{
      harness: "codex",
      providerIds: ["codex-app-server", "openai"],
      state: "signed_in",
      email: "machine@acme.com",
      usage: [{ window: "weekly", usedPercent: 64, resetsAt: null }],
      usageAt: Date.now() - 5 * 60_000,
    }]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["machine"]))
    expect(accountDetail("openai", "machine"))
      .toBe("settings.providers.live.window:settings.providers.window.weekly|64")
    expect(accountChecked("openai", "machine")).toBe("5m")
  })

  test("a machine login carrying no windows says the plan and the organization instead", async () => {
    state.machineLogins = [{
      harness: "claude",
      providerIds: ["claude-acp", "claude-sdk"],
      state: "signed_in",
      email: "person@acme.com",
      plan: "max",
      org: "Acme",
    }]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["machine"]))
    expect(accountDetail("anthropic", "machine")).toBe([
      "settings.providers.agents.machinePlan:max",
      "Acme",
    ].join(" · "))
  })

  test("a signed-out harness still offers its own login, because choosing it stores nothing", async () => {
    // A stored account holds the mark, so the machine row is a choice to make
    // rather than the one already made.
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "work@acme.com", account_id: "acc_1", is_active: true },
    ]
    state.machineLogins = [
      { harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_out" },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "machine"]))
    const radio = accountRow("openai", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!
    expect(radio.disabled).toBe(false)
    expect(accountRow("openai", "machine").textContent).toContain("settings.providers.agents.machineLogin")
    expect(accountDetail("openai", "machine")).toBe("settings.providers.agents.machineSignedOut:codex login")

    radio.click()

    await waitFor(() => expect(state.machineActivated).toEqual([["codex-app-server", "openai"]]))
  })

  test("a harness that is not installed is listed and is not a choice", async () => {
    state.machineLogins = [
      { harness: "claude", providerIds: ["claude-acp", "claude-sdk"], state: "absent" },
    ]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["machine"]))
    expect(accountRow("anthropic", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!.disabled)
      .toBe(true)
    expect(accountDetail("anthropic", "machine")).toBe("settings.providers.agents.machineNotInstalled")
  })

  test("a harness that could not be asked says so rather than reading as signed out", async () => {
    state.machineLogins = [{
      harness: "cursor",
      providerIds: ["cursor-acp", "cursor-sdk"],
      state: "unknown",
      detail: "Cursor did not answer with a login status.",
    }]
    mount()
    await waitFor(() => expect(accountIds("cursor")).toEqual(["machine"]))
    expect(accountRow("cursor", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!.disabled)
      .toBe(false)
    expect(accountDetail("cursor", "machine")).toBe("Cursor did not answer with a login status.")
  })

  test("a login that drives part of its harness says which part behind the hint, not on the line", async () => {
    state.machineLogins = [{
      harness: "cursor",
      providerIds: [...HARNESS_TABLE.cursor.providerIds],
      serves: [...HARNESS_TABLE.cursor.machineLoginServes],
      state: "signed_in",
    }]
    mount()
    await waitFor(() => expect(accountIds("cursor")).toEqual(["machine"]))
    expect(accountNote("cursor", "machine"))
      .toBe("settings.providers.agents.machineCursorAcp · settings.providers.agents.machineCursorSdkKey")
    expect(accountDetail("cursor", "machine")).toBe("")
    expect(accountRow("cursor", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!.disabled)
      .toBe(false)
  })

  test("a login that drives every binding hangs no hint off its label", async () => {
    state.machineLogins = [
      { harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_in", email: "machine@acme.com" },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["machine"]))
    expect(accountRow("openai", "machine").querySelector('[data-component="agent-account-note"]')).toBeNull()
  })

  test("where a turn on an entry can run is the authority's answer, never that the row is stored", async () => {
    state.storedCredentials = [
      {
        id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "work@acme.com",
        account_id: "acc_1", is_active: true, deliverable: { local: true, cloud: true },
      },
      {
        // Stored exactly like the row above, and refused in a sandbox: the
        // destination needs a header only this machine can add.
        id: "cred_codex_companion", provider_id: "codex-app-server", kind: "oauth_token", label: "home@acme.com",
        account_id: "acc_2", is_active: false,
        deliverable: { local: true, cloud: false, reason: "needs a companion header" },
      },
    ]
    state.machineLogins = [
      { harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_in", email: "machine@acme.com" },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "cred_codex_companion", "machine"]))
    expect(accountReachIcons("openai", "cred_codex")).toEqual(["monitor", "cloud"])
    expect(accountReachIcons("openai", "cred_codex_companion")).toEqual(["monitor"])
    expect(accountReachIcons("openai", "machine")).toEqual(["monitor"])
  })

  test("this computer's login is not a choice while the harness runs on a binding it cannot drive", async () => {
    state.storedCredentials = [
      { id: "cred_cursor_key", provider_id: "cursor-sdk", kind: "api_key", label: "key@acme.com", account_id: "acc_c", is_active: true },
    ]
    state.machineLogins = [{
      harness: "cursor",
      providerIds: [...HARNESS_TABLE.cursor.providerIds],
      serves: [...HARNESS_TABLE.cursor.machineLoginServes],
      state: "signed_in",
    }]
    mount()
    await waitFor(() => expect(accountIds("cursor")).toEqual(["cred_cursor_key", "machine"]))
    const radio = accountRow("cursor", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!
    expect(radio.disabled).toBe(true)
    // The reason travels with the reach it belongs to, behind the one hint.
    expect(accountNote("cursor", "machine")).toBe([
      "settings.providers.agents.machineCursorAcp",
      "settings.providers.agents.machineCursorSdkKey",
      "settings.providers.agents.machineStrands:Cursor",
    ].join(" · "))
  })

  test("a login that drives both of its harness's bindings is whole, whatever vendor id sits beside them", async () => {
    // Claude Code resolves `anthropic` too, and that is a vendor's models rather
    // than a binding signing the CLI in was ever going to answer for. Counting
    // it read this login as partial and hung a hint off a complete row.
    state.machineLogins = [{
      harness: "claude",
      providerIds: [...HARNESS_TABLE.claude.providerIds],
      serves: [...HARNESS_TABLE.claude.machineLoginServes],
      state: "signed_in",
      email: "machine@acme.com",
    }]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["machine"]))
    expect(accountNote("anthropic", "machine")).toBe("")
    expect(accountRow("anthropic", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!.disabled)
      .toBe(false)
  })

  test("a login that grows to cover the SDK loses the hint that said it did not", async () => {
    // The words exist for a login narrower than its harness; what makes it
    // narrow is the bindings it misses, never how many vendor ids sit beside
    // them — `cursor` is one of Cursor's provider ids and is not a binding.
    state.machineLogins = [{
      harness: "cursor",
      providerIds: [...HARNESS_TABLE.cursor.providerIds],
      serves: harnessBindingIds("cursor"),
      state: "signed_in",
    }]
    mount()
    await waitFor(() => expect(accountIds("cursor")).toEqual(["machine"]))
    expect(accountNote("cursor", "machine")).toBe("")
  })

  test("a vendor key in use never strands the login that would replace it", async () => {
    state.storedCredentials = [
      { id: "cred_anthropic", provider_id: "anthropic", kind: "api_key", label: "key@acme.com", account_id: "acc_k", is_active: true },
    ]
    state.machineLogins = [{
      harness: "claude",
      providerIds: [...HARNESS_TABLE.claude.providerIds],
      serves: [...HARNESS_TABLE.claude.machineLoginServes],
      state: "signed_in",
      email: "machine@acme.com",
    }]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["cred_anthropic", "machine"]))
    // Withdrawing the key's mark hands Claude Code back to its own login, which
    // is exactly what choosing this row means; nothing is left without auth.
    expect(accountRow("anthropic", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!.disabled)
      .toBe(false)
    expect(accountNote("anthropic", "machine")).toBe("")
  })

  test("a login that drives every binding of its harness is a choice whatever is stored", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "work@acme.com", account_id: "acc_1", is_active: true },
    ]
    state.machineLogins = [
      { harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_in", email: "machine@acme.com" },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "machine"]))
    expect(accountRow("openai", "machine").querySelector<HTMLInputElement>('input[type="radio"]')!.disabled)
      .toBe(false)
    expect(accountRow("openai", "machine").getAttribute("title")).toBe(null)
  })

  test("Check on this computer's login asks that harness again, and nothing else", async () => {
    state.machineLogins = [{
      harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_in", email: "machine@acme.com", plan: "pro",
    }]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["machine"]))
    state.machineLogins = [{
      harness: "codex",
      providerIds: ["codex-app-server", "openai"],
      state: "signed_in",
      email: "machine@acme.com",
      usage: [{ window: "session", usedPercent: 5, resetsAt: null }],
    }]
    state.credentialCalls.length = 0

    rowAction("openai", "machine", "check").click()

    await waitFor(() => expect(accountDetail("openai", "machine"))
      .toBe("settings.providers.live.window:settings.providers.window.session|5"))
    expect(state.credentialCalls).toEqual(["GET /api/claxedo/credentials/machine-logins?harness=codex&fresh=1"])
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
    state.machineLogins = [{
      harness: "claude", providerIds: ["claude-acp", "claude-sdk"], state: "signed_in", email: "machine@acme.com",
    }]
    mount()

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work", "machine"]))
    expect(selectedAccount("anthropic")).toBe("sdk_work")
  })

  test("choosing this computer's login withdraws the mark rather than storing anything", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "api_key", label: "spare@acme.com", account_id: "fp_0123abcd…wxyz", is_active: true },
    ]
    state.machineLogins = [{
      harness: "codex", providerIds: ["codex-app-server", "openai"], state: "signed_in", email: "machine@acme.com",
    }]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "machine"]))
    expect(selectedAccount("openai")).toBe("cred_codex")

    accountRow("openai", "machine")
      .querySelector<HTMLInputElement>('input[type="radio"]')!.click()

    await waitFor(() => expect(selectedAccount("openai")).toBe("machine"))
    expect(state.machineActivated).toEqual([["codex-app-server", "openai"]])
    // Nothing was copied: the store holds exactly the account it held before.
    expect(state.activated).toEqual([])
    expect(state.storedCredentials.map((row) => row.id)).toEqual(["cred_codex"])
  })

  test("Check asks the provider and rewrites that entry's status", async () => {
    state.storedCredentials = [
      { id: "cred_codex", provider_id: "codex-app-server", kind: "oauth_token", label: "work@acme.com", is_active: true },
      { id: "cred_codex_two", provider_id: "codex-app-server", kind: "oauth_token", label: "home@acme.com", account_id: "acc_2", is_active: false },
    ]
    mount()
    await waitFor(() => expect(accountIds("openai")).toEqual(["cred_codex", "cred_codex_two"]))
    // Nothing to say until the provider has been asked.
    expect(accountDetail("openai", "cred_codex")).toBe("")

    rowAction("openai", "cred_codex", "check").click()

    await waitFor(() => expect(accountChecked("openai", "cred_codex")).toBe("common.justNow"))
    expect(accountRefused("openai", "cred_codex")).toBe(false)
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

    await waitFor(() => expect(accountIds("anthropic")).toEqual(["sdk_work"]))
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

  test("removing the last account empties the list and puts Connect back in the header", async () => {
    state.storedCredentials = [
      { id: "cred_token", provider_id: "claude-sdk", kind: "oauth_token", label: "work@acme.com", is_active: true },
    ]
    mount()
    await waitFor(() => expect(accountIds("anthropic")).toEqual(["cred_token"]))
    expect(agentAction("anthropic")).toBe("agent-add-account")

    rowAction("anthropic", "cred_token", "remove").click()
    rowAction("anthropic", "cred_token", "remove-confirm").click()

    await waitFor(() => expect(accountIds("anthropic")).toEqual([]))
    expect(agentAction("anthropic")).toBe("agent-add-account")
  })

  test("Add an account opens the connect card with no row named, and saving rescans", async () => {
    mount()
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    expect(agentRow("cursor").querySelector('[data-component="provider-connect-card"]')).toBeNull()

    agentRow("cursor").querySelector<HTMLButtonElement>('[data-action="agent-add-account"]')!.click()

    const card = agentRow("cursor").querySelector('[data-component="provider-connect-card"]')
    expect(card?.getAttribute("data-credential")).toBeNull()
    expect(card?.textContent).toContain("provider.connect.title.harness:Cursor")
    state.credentialCalls.length = 0

    within(agentRow("cursor")).getByTestId("provider-connect-save").click()

    await waitFor(() => expect(state.credentialCalls).toContain("GET /api/claxedo/credentials/machine-logins"))
  })

  test("a scan that fails tells the user what broke, not that a scan failed", async () => {
    state.machineLoginFailure = "Codex app-server did not answer in time"
    mount()

    await waitFor(() => expect(state.toasts).toEqual(["Codex app-server did not answer in time"]))
    // The loader does not outlive the attempt: the rows are drawn, and the
    // header says the read did not land rather than claiming a scan.
    await waitFor(() => expect(providerIds("agents")).toHaveLength(3))
    expect(section("agents").querySelector('[data-component="agents-scanning"]')).toBeNull()
    expect(section("agents").querySelector('[data-component="agents-scanned-at"]')?.textContent)
      .toBe("settings.providers.agents.scanFailed")
  })
})
