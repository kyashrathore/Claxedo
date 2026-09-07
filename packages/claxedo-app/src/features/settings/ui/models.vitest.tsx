/** Models is the surface that still asks which (workspace, harness) it edits. */
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { connectionHarness, harnessSelectionKey, nativeHarness, type HarnessSelection } from "@/platform/identity/harness-selection"

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

const clients = new Set<QueryClient>()

const state = vi.hoisted(() => ({
  /** Every (scope, harness) pair the page asked a catalog for, in order. */
  requests: [] as Array<{ scope?: string; harness: string }>,
  catalogs: {} as Record<string, string[]>,
  /** The harness the workspace's draft-default record remembers, if any. */
  rememberedHarness: undefined as HarnessSelection | undefined,
  projects: [] as CatalogProject[],
}))

vi.mock("@/features/settings/app-ports", async () => {
  const { useProviders } = await import("@/app/providers/use-providers")
  return {
    useProviders,
    useModels: () => ({ visible: () => true, setVisibility: () => undefined }),
    useShellQueryOptions: () => ({
      projects: () => ({
        queryKey: ["models-vitest", "projects", state.projects.map((project) => project.id).join(",")],
        queryFn: async () => state.projects,
      }),
    }),
    useSDK: () => {
      throw new Error("no workspace SDK scope")
    },
    useEnabledAcpHarnesses: () => () => [{ key: "team-agent", label: "Team Agent" }],
    readWorkspaceHarnessDefault: () => state.rememberedHarness,
  }
})

vi.mock("@/app/providers/sdk/sdk", () => ({
  useSDK: () => {
    throw new Error("no focused workspace")
  },
}))
vi.mock("@/app/integrations/sync/query-options", () => ({
  useShellQueryOptions: () => ({
    providers: (scope: string | null, harness: string) => ({
      queryKey: ["providers", scope, harness],
      queryFn: async () => {
        state.requests.push({ scope: scope ?? undefined, harness })
        const ids = state.catalogs[`${scope ?? ""}|${harness}`] ?? []
        return {
          all: new Map(ids.map((id) => [id, { id, name: id, models: {}, source: "api" }])),
          connected: [] as string[],
          default: {},
        }
      },
    }),
  }),
}))

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${Object.values(vars).join("|")}` : key),
    locale: () => "en",
  }),
}))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/api/api")>()),
  getClaxedoServerUrl: () => "http://127.0.0.1:2593",
}))

// The pickers are the surface under test, so they render as native selects whose
// current value the test can read directly.
vi.mock("@opencode-ai/ui/select", () => ({
  Select: (props: {
    "data-action"?: string
    options: Array<Record<string, string>>
    current?: Record<string, string>
    value: (option: Record<string, string>) => string
  }) => (
    <select data-testid={props["data-action"]} value={props.current ? props.value(props.current) : ""}>
      <option value="" disabled />
      {props.options.map((option) => (
        <option value={props.value(option)}>{props.value(option)}</option>
      ))}
    </select>
  ),
}))

const { SettingsScopeProvider } = await import("@/features/settings/scope/settings-scope")
const { SettingsModels } = await import("./models")

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  return render(() => (
    <QueryClientProvider client={client}>
      <SettingsScopeProvider>
        <SettingsModels />
      </SettingsScopeProvider>
    </QueryClientProvider>
  ))
}

function harnessPicker() {
  return screen.getByTestId("settings-scope-harness")
}

/** Reads issued after the workspace catalog answered; the page fires one before it. */
function scopedRequests() {
  return state.requests.filter((request) => request.scope)
}

beforeEach(() => {
  state.requests.length = 0
  state.rememberedHarness = nativeHarness("pi")
  state.projects = [LOCAL_PROJECT, CLOUD_PROJECT]
  state.catalogs = {
    "workspace:ws_local|pi": ["anthropic"],
    "workspace:ws_local|opencode": ["external-backend"],
    "workspace:ws_cloud|pi": ["cloud-backend"],
  }
})

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients.clear()
})

describe("Settings → Models names the (workspace, harness) it edits", () => {
  test("the workspace picker is hidden when the catalog offers a single workspace", async () => {
    state.projects = [LOCAL_PROJECT]
    mount()
    await waitFor(() => expect(scopedRequests()).not.toHaveLength(0))
    expect(screen.queryByTestId("settings-scope-workspace")).toBeNull()
    expect(scopedRequests().every((request) => request.scope === "workspace:ws_local")).toBe(true)
  })

  test("the workspace picker appears once the catalog offers a choice", async () => {
    mount()
    await waitFor(() => expect(screen.getByTestId("settings-scope-workspace")).toHaveValue("/repo"))
    expect(document.querySelector('[data-component="settings-scope-selector"]')).not.toBeNull()
  })

  test("a workspace that remembers no harness still names one, so the page does not render blank", async () => {
    state.rememberedHarness = undefined
    mount()
    await waitFor(() => expect(screen.getByTestId("settings-scope-workspace")).toHaveValue("/repo"))
    expect(harnessPicker()).toHaveValue(encodeURIComponent(harnessSelectionKey(nativeHarness("opencode"))))
    expect(scopedRequests()).toEqual([{ scope: "workspace:ws_local", harness: "opencode" }])
  })

  test("an unavailable remembered connection stays unselected instead of substituting a native harness", async () => {
    state.rememberedHarness = connectionHarness("removed-connection")
    mount()
    await waitFor(() => expect(screen.getByTestId("settings-scope-workspace")).toHaveValue("/repo"))
    expect(harnessPicker()).toHaveValue("")
  })
})
