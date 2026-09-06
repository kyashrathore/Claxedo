/** Native catalog transport and provider-management affordances use the real hooks. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"

const clients = new Set<QueryClient>()
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { nativeHarness, connectionHarness, harnessSelectionKey, type HarnessSelection } from "@/platform/identity/harness-selection"

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
}))

vi.mock("@/features/settings/app-ports", async () => {
  const { useProviders } = await import("@/app/providers/use-providers")
  return {
    useProviders,
    useShellQueryOptions: () => ({
      projects: () => ({
        queryKey: ["providers-vitest", "projects"],
        queryFn: async () => [
          {
            id: "proj_local",
            name: "acme/app",
            worktree: "/repo",
            workspaces: {
              "/repo": { workspaceId: "ws_local", kind: "local", workspace_name: "main", directory: "/repo" },
            },
          },
          {
            id: "proj_cloud",
            name: "acme/api",
            worktree: "workspace:ws_cloud",
            workspaces: {
              "workspace:ws_cloud": {
                workspaceId: "ws_cloud",
                kind: "cloud",
                workspace_name: "sandbox",
                directory: "/workspace",
              },
            },
          },
        ],
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

vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => undefined }) }))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
vi.mock("@/platform/api/credential-request", () => ({
  claxedoCredentialRequest: async ({ providerId }: { providerId: string }, init?: RequestInit) => {
    state.credentialDeletes.push({ providerId, method: init?.method })
    return new Response("{}")
  },
}))
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

/** The provider rows the page actually rendered, by id. */
function renderedProviderIds() {
  return [...document.querySelectorAll<HTMLElement>("[data-provider]")]
    .map((node) => node.getAttribute("data-provider") ?? "")
    .filter(Boolean)
    .sort()
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
  state.catalogs = {
    "workspace:ws_local|pi": ["anthropic", "openai"],
    "workspace:ws_local|opencode": ["external-backend"],
    "workspace:ws_local|claude": ["claude"],
    "workspace:ws_cloud|pi": ["cloud-backend"],
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

  test("opens on the selected native Pi catalog", async () => {
    mount()
    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("/repo"))
    expect(select("settings-scope-harness").value).toBe(encodeURIComponent(harnessSelectionKey(nativeHarness("pi"))))
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))
    expect(state.requests).toEqual([{ scope: "workspace:ws_local", harness: "pi" }])
  })

  test.each([nativeHarness("claude"), nativeHarness("cursor"), connectionHarness("team-agent"), connectionHarness("opencode"), connectionHarness("pi")])("%j manages credentials externally and never requests a native catalog", async (harness) => {
    state.rememberedHarness = harness
    mount()
    await waitFor(() => expect(select("settings-scope-harness").value).toBe(encodeURIComponent(harnessSelectionKey(harness))))
    expect(document.querySelector('[data-component="providers-externally-managed"]')).not.toBeNull()
    expect(renderedProviderIds()).toEqual([])
    expect(state.requests).toEqual([])
    expect(state.authReads).toEqual([])
    expect(screen.queryByText("provider.custom.title")).toBeNull()
  })

  test("switching from Pi to an external connection clears provider affordances", async () => {
    mount()
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))
    choose("settings-scope-harness", harnessSelectionKey(connectionHarness("pi")))
    await waitFor(() => expect(renderedProviderIds()).toEqual([]))
    expect(state.requests).toEqual([{ scope: "workspace:ws_local", harness: "pi" }])
    expect(document.querySelector('[data-component="providers-externally-managed"]')).not.toBeNull()
  })

  test("Pi presentation caches remain isolated when changing workspace", async () => {
    mount()
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))
    choose("settings-scope-workspace", "ws_cloud")
    await waitFor(() => expect(renderedProviderIds()).toEqual(["cloud-backend"]))
    expect(state.requests.at(-1)).toEqual({ scope: "workspace:ws_cloud", harness: "pi" })
    choose("settings-scope-workspace", "/repo")
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))
  })

  test("a workspace with nothing remembered performs no catalog request until a harness is selected", async () => {
    state.rememberedHarness = undefined
    mount()
    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("/repo"))
    expect(select("settings-scope-harness").value).toBe("")
    expect(renderedProviderIds()).toEqual([])
    expect(document.querySelector('[data-component="providers-catalog-empty"]')).toBeNull()
    expect(state.requests).toEqual([])
    choose("settings-scope-harness", harnessSelectionKey(nativeHarness("pi")))
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))
    expect(state.requests).toEqual([{ scope: "workspace:ws_local", harness: "pi" }])
  })

  test("an unavailable remembered connection stays unselected instead of substituting a native harness", async () => {
    state.rememberedHarness = connectionHarness("removed-connection")
    mount()
    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("/repo"))
    expect(select("settings-scope-harness").value).toBe("")
    expect(state.requests).toEqual([])
  })

  test("config and environment providers cannot disconnect but API and custom credentials can", async () => {
    state.catalogs = {
      "workspace:ws_local|pi": ["config-provider", "env-provider", "api-provider", "custom-provider"],
    }
    state.sources = {
      "config-provider": "config",
      "env-provider": "env",
      "api-provider": "api",
      "custom-provider": "custom",
    }
    state.connected = ["config-provider", "env-provider", "api-provider", "custom-provider"]
    mount()
    await waitFor(() => expect(renderedProviderIds()).toHaveLength(4))
    for (const id of ["config-provider", "env-provider"]) {
      const row = document.querySelector<HTMLElement>(`[data-provider="${id}"]`)!
      expect(within(row).queryByRole("button", { name: "common.disconnect" })).toBeNull()
    }
    for (const id of ["api-provider", "custom-provider"]) {
      const row = document.querySelector<HTMLElement>(`[data-provider="${id}"]`)!
      expect(within(row).getByRole("button", { name: "common.disconnect" })).toBeInTheDocument()
    }
    const row = document.querySelector<HTMLElement>('[data-provider="api-provider"]')!
    fireEvent.click(within(row).getByRole("button", { name: "common.disconnect" }))
    await waitFor(() =>
      expect(state.authDeletes).toEqual([
        "http://127.0.0.1:2593/auth/api-provider?harness=pi&directory=workspace%3Aws_local",
      ]),
    )
    expect(state.credentialDeletes).toEqual([{ providerId: "api-provider", method: "DELETE" }])
    expect(state.connected).toEqual(["config-provider", "env-provider", "custom-provider"])
    await waitFor(() => {
      const disconnected = document.querySelector<HTMLElement>('[data-provider="api-provider"]')!
      expect(within(disconnected).getByRole("button", { name: "common.connect" })).toBeVisible()
      expect(within(disconnected).queryByRole("button", { name: "common.disconnect" })).toBeNull()
    })
    expect(state.requests.at(-1)).toEqual({ scope: "workspace:ws_local", harness: "pi" })
  })
})
