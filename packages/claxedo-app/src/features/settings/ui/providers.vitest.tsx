/**
 * Settings → Providers is a (workspace, harness) surface.
 *
 * The catalog, its credentials and the connect flow all belong to the machine
 * serving one workspace and to one harness on it, so this pins that the page
 * asks for exactly the pair the scope selector names — and that a harness with
 * no catalog says so instead of rendering an empty list that reads as "no
 * providers exist".
 */
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  /** Every (scope, harness) pair the page asked a catalog for, in order. */
  requests: [] as Array<{ scope?: string; harness: string }>,
  catalogs: {} as Record<string, string[]>,
  /** The harness the workspace's draft-default record remembers, if any. */
  rememberedHarness: undefined as string | undefined,
}))

vi.mock("@/features/settings/app-ports", async () => {
  const solid = await import("solid-js")
  return {
    useProviders: (harness: string | (() => string), scope?: string | (() => string | undefined)) => {
      const read = () => ({
        harness: typeof harness === "function" ? harness() : harness,
        scope: typeof scope === "function" ? scope() : scope,
      })
      const catalog = solid.createMemo(() => {
        const request = read()
        state.requests.push(request)
        return state.catalogs[`${request.scope ?? ""}|${request.harness}`] ?? []
      })
      const all = solid.createMemo(() =>
        new Map(catalog().map((id) => [id, { id, name: id, models: {}, source: "api" }] as const)))
      return {
        state: () => ({ all: all(), connected: [], default: {} }),
        loading: () => false,
        error: () => undefined,
        refresh: async () => undefined,
        load: async () => undefined,
        queryKey: () => ["providers", read().scope, read().harness],
        all,
        default: () => ({}),
        popular: () => [],
        connected: () => [],
      }
    },
    DialogCustomProvider: () => <div />,
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
    useSDK: () => { throw new Error("no workspace SDK scope") },
    useEnabledAcpHarnesses: () => () => [],
    readWorkspaceHarnessDefault: () => state.rememberedHarness,
  }
})

vi.mock("@/platform/i18n/provider", () => ({
  useLanguage: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join("|")}` : key,
    locale: () => "en",
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => undefined }) }))
vi.mock("@opencode-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
vi.mock("@/platform/api/credential-request", () => ({ claxedoCredentialRequest: async () => new Response("{}") }))
vi.mock("@/platform/api/api", () => ({
  authFetch: async () => new Response("{}"),
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
      {props.options.map((option) => (
        <option value={props.value(option)}>{props.value(option)}</option>
      ))}
    </select>
  ),
}))

const { SettingsScopeProvider } = await import("@/features/settings/scope/settings-scope")
const { SettingsProviders } = await import("./providers")

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
  return screen.getByTestId(testId) as HTMLSelectElement
}

function choose(testId: string, value: string) {
  const element = select(testId)
  element.value = value
  element.dispatchEvent(new Event("change", { bubbles: true }))
}

beforeEach(() => {
  state.requests.length = 0
  state.rememberedHarness = "opencode"
  state.catalogs = {
    "workspace:ws_local|opencode": ["anthropic", "openai"],
    "workspace:ws_local|claude-sdk": ["claude-sdk"],
    "workspace:ws_cloud|opencode": ["opencode"],
  }
})

afterEach(() => cleanup())

describe("Settings → Providers reads under the selected (workspace, harness)", () => {
  test("opens on the focused-less default workspace and the harness it last used", async () => {
    mount()

    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("ws_local"))
    expect(select("settings-scope-harness").value).toBe("opencode")
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))
    expect(state.requests.at(-1)).toEqual({ scope: "workspace:ws_local", harness: "opencode" })
  })

  test("choosing another harness re-reads that harness's catalog for the same workspace", async () => {
    mount()
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))

    choose("settings-scope-harness", "claude-sdk")

    await waitFor(() => expect(renderedProviderIds()).toEqual(["claude-sdk"]))
    expect(state.requests.at(-1)).toEqual({ scope: "workspace:ws_local", harness: "claude-sdk" })
  })

  test("choosing another workspace re-reads the same harness on that workspace", async () => {
    mount()
    await waitFor(() => expect(renderedProviderIds()).toEqual(["anthropic", "openai"]))

    choose("settings-scope-workspace", "ws_cloud")

    await waitFor(() => expect(renderedProviderIds()).toEqual(["opencode"]))
    expect(state.requests.at(-1)).toEqual({ scope: "workspace:ws_cloud", harness: "opencode" })
  })

  test("a harness with no catalog for this workspace says so rather than rendering nothing", async () => {
    mount()
    await waitFor(() => expect(screen.getByText("anthropic")).toBeInTheDocument())

    choose("settings-scope-harness", "cursor-sdk")

    await waitFor(() =>
      expect(screen.getByText("settings.providers.catalog.empty:Cursor SDK|main")).toBeInTheDocument())
  })

  test("the custom-provider entry belongs to the OpenCode registry and no other harness", async () => {
    mount()
    await waitFor(() => expect(screen.getByText("provider.custom.title")).toBeInTheDocument())

    choose("settings-scope-harness", "claude-sdk")

    await waitFor(() => expect(screen.queryByText("provider.custom.title")).toBeNull())
  })

  // A workspace nobody has picked a harness in yet is the ordinary first-run
  // state, and it opens on the SAME harness a new draft in it opens on — so
  // Settings and that workspace's composer edit one half of its per-harness
  // model store, not two.
  test("a workspace with nothing remembered opens on the product default harness", async () => {
    state.rememberedHarness = undefined
    mount()

    await waitFor(() => expect(select("settings-scope-workspace").value).toBe("ws_local"))
    expect(select("settings-scope-harness").value).toBe("opencode")
    expect(state.requests.at(-1)).toEqual({ scope: "workspace:ws_local", harness: "opencode" })
  })

  // The custom-provider entry ADDS a provider to the OpenCode registry, so an
  // empty registry is exactly when it has to stay reachable.
  test("the custom-provider entry still renders when the OpenCode catalog is empty", async () => {
    state.catalogs = {}
    mount()

    await waitFor(() =>
      expect(screen.getByText("settings.providers.catalog.empty:OpenCode|main")).toBeInTheDocument())
    expect(screen.getByText("provider.custom.title")).toBeInTheDocument()
  })

  test("no catalog is ever requested without a harness", async () => {
    mount()
    await waitFor(() => expect(state.requests.length).toBeGreaterThan(0))
    expect(state.requests.every((request) => !!request.harness)).toBe(true)
  })
})
