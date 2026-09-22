/** Models lists every harness's providers for the workspace in view and edits one app-wide visibility answer. */
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { HarnessSelection } from "@/platform/identity/harness-selection"

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

const clients = new Set<QueryClient>()

const state = vi.hoisted(() => ({
  /** Every (scope, harness) pair the page asked a catalog for, in order. */
  requests: [] as Array<{ scope?: string; harness: string }>,
  projects: [] as CatalogProject[],
  /** What each non-catalog harness reports through its options endpoint. */
  harnessModels: {} as Record<string, Array<{ id: string; name: string; connected?: boolean }>>,
  optionRequests: [] as Array<{ directory: string; harness: string }>,
  setVisibility: [] as Array<[{ providerID: string; modelID: string }, boolean]>,
  setGroupVisibility: [] as Array<[string, boolean, number]>,
  /** Model keys the visibility record hides. */
  hidden: new Set<string>(),
  /** Group answers the visibility record holds. */
  groups: {} as Record<string, "show" | "hide">,
  /** A harness whose options endpoint fails, and how. */
  failing: undefined as { harness: string; message: string } | undefined,
}))

vi.mock("@/features/settings/app-ports", async () => {
  const { useProviders } = await import("@/app/providers/use-providers")
  const { groupHarnessModels } = await import("@/features/session/harness/harness-model-options")
  const { harnessSelectionId } = await import("@/features/session/harness/profile")
  const { localHarnessChecks } = await import("@/features/onboarding/ai-connect-state")
  // Delegates to the shipped rule rather than restating it: a fake that
  // answered visibility its own way would keep passing while the rule it
  // stands in for changed underneath.
  const { resolveModelVisibility } = await import("@/features/session/providers/models")
  return {
    useProviders,
    useModelVisibility: () => ({
      visible: (
        key: { providerID: string; modelID: string },
        context: { defaults?: Record<string, string>; group?: string; connected?: boolean } = {},
      ) =>
        resolveModelVisibility({
          model: key,
          defaults: context.defaults ?? {},
          ...(state.hidden.has(`${key.providerID}:${key.modelID}`) ? { user: "hide" as const } : {}),
          ...(context.group && state.groups[context.group] ? { group: state.groups[context.group] } : {}),
          ...(context.connected === undefined ? {} : { connected: context.connected }),
        }),
      setVisibility: (key: { providerID: string; modelID: string }, checked: boolean) => {
        state.setVisibility.push([key, checked])
      },
      groupVisibility: (group: string) => state.groups[group],
      setGroupVisibility: (group: string, checked: boolean, models: readonly unknown[]) => {
        state.setGroupVisibility.push([group, checked, models.length])
      },
    }),
    groupHarnessModels,
    loadHarnessModelOptions: async (input: { scope: { directory?: string }; harness: HarnessSelection }) => {
      const harness = harnessSelectionId(input.harness)
      state.optionRequests.push({ directory: input.scope.directory ?? "", harness })
      if (state.failing?.harness === harness) throw new Error(state.failing.message)
      return state.harnessModels[harness] ?? []
    },
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
    useGlobalSDK: () => ({ url: "http://127.0.0.1:2593" }),
    localHarnessChecks: () => localHarnessChecks,
    loadMachineLogins: async () => [],
    verifyAIConnection: async () => ({ result: "ok" as const }),
  }
})

// This suite is about the models half; the accounts half only has to mount.
// `models-accounts.vitest.tsx` drives the real scan against the credential routes.
vi.mock("@/features/settings/provider-detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/settings/provider-detect")>()),
  runProviderDetect: async () => ({ stored: [], effective: new Map(), machineLogins: [] }),
}))

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
        return {
          all: new Map([
            ["anthropic", { id: "anthropic", name: "Anthropic", models: { opus: { id: "opus", name: "Opus" }, sonnet: { id: "sonnet", name: "Sonnet" } }, source: "api" }],
            ["openai", { id: "openai", name: "OpenAI", models: { gpt: { id: "gpt", name: "GPT" } }, source: "api" }],
          ]),
          connected: ["anthropic", "openai"],
          default: { anthropic: "opus", openai: "gpt" },
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
// The accounts half reaches for the custom-provider dialog; this suite never opens one.
vi.mock("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {}, close: () => {} }) }))
vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/api/api")>()),
  getClaxedoServerUrl: () => "http://127.0.0.1:2593",
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

function section(slug: string) {
  return document.querySelector<HTMLElement>(`[data-component="models-section-${slug}"]`)
}

/** Accounts is the tab a harness opens on; these tests are about the other one. */
async function showModels(slug: string) {
  const tab = await waitFor(() => {
    const button = section(slug)?.querySelector<HTMLButtonElement>('[data-action="settings-models-tab-models"]')
    if (!button) throw new Error(`${slug} has no models tab`)
    return button
  })
  tab.click()
}

function groups(slug: string) {
  return [...(section(slug)?.querySelectorAll<HTMLElement>('[data-component="models-group"]') ?? [])]
}

function groupKeys(slug: string) {
  return groups(slug).map((group) => group.dataset.group ?? "")
}

function groupCounts(slug: string) {
  return groups(slug).map((group) =>
    group.querySelector<HTMLElement>('[data-component="models-group-row"]')?.textContent?.trim() ?? "")
}

function browseRows(slug: string) {
  return [...(section(slug)?.querySelectorAll<HTMLElement>('[data-component="models-browse-row"]') ?? [])].map((row) => row.textContent?.trim() ?? "")
}

function expand(slug: string, index = 0) {
  groups(slug)[index].querySelector<HTMLButtonElement>('[data-action="settings-models-group-expand"]')!.click()
}


beforeEach(() => {
  state.requests.length = 0
  state.optionRequests.length = 0
  state.setVisibility.length = 0
  state.setGroupVisibility.length = 0
  state.harnessModels = {}
  state.hidden = new Set()
  state.groups = {}
  state.failing = undefined
  state.projects = [LOCAL_PROJECT]
})

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients.clear()
})

describe("Settings → Models", () => {
  test("each harness is its own section, listing providers with how many of their models are on", async () => {
    state.harnessModels.claude = [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }]
    mount()
    await showModels("claude")
    await showModels("opencode")
    // A harness that is its own provider names itself once, in the section
    // header; its models sit directly under the tabs with no second heading.
    await waitFor(() => expect(browseRows("claude")).toEqual(["OpusOpus", "SonnetSonnet"]))
    expect(groups("claude")).toEqual([])
    await waitFor(() => expect(groupKeys("opencode")).toEqual(["anthropic", "openai"]))
    // The catalog offers each connected provider's default until more is asked for.
    expect(groupCounts("opencode")).toEqual([
      "Anthropicsettings.models.group.count:1|2settings.models.group.disableAll",
      "OpenAIsettings.models.group.count:1|1settings.models.group.disableAll",
    ])
    for (const slug of ["claude", "codex", "cursor", "pi", "opencode", "connection:team-agent"]) expect(section(slug)).not.toBeNull()
    expect(document.querySelector('[data-component="settings-scope-selector"]')).toBeNull()
    expect(section("claude")?.textContent).toContain("settings.models.enabled.count:2")
  })

  test("a vendor a harness cannot reach stays shut; one it can is already open", async () => {
    state.harnessModels.pi = [
      { id: "openai/gpt-5.4", name: "GPT-5.4", connected: true },
      { id: "amazon-bedrock/nova-lite", name: "Nova Lite", connected: false },
    ]
    mount()
    await waitFor(() => expect(section("pi")).not.toBeNull())
    await showModels("pi")
    await waitFor(() => expect(groups("pi")).toHaveLength(2))
    expect(browseRows("pi")).toEqual(["GPT-5.4GPT-5.4"])
    expand("pi", 1)
    await waitFor(() => expect(browseRows("pi")).toEqual(["GPT-5.4GPT-5.4", "Nova LiteNova Lite"]))
    section("pi")!.querySelector<HTMLInputElement>('[data-component="models-browse-row"] input[type="checkbox"]')!.click()
    await waitFor(() => expect(state.setVisibility).toEqual([[{ providerID: "pi", modelID: "openai/gpt-5.4" }, false]]))
  })

  test("a provider's own action answers for every model it holds at once", async () => {
    state.harnessModels.pi = [
      { id: "openai/gpt-5.4", name: "GPT-5.4", connected: true },
      { id: "openai/gpt-5.3", name: "GPT-5.3", connected: true },
    ]
    mount()
    await waitFor(() => expect(section("pi")).not.toBeNull())
    await showModels("pi")
    await waitFor(() => expect(groups("pi")).toHaveLength(1))
    groups("pi")[0].querySelector<HTMLButtonElement>('[data-action="settings-models-group-toggle-all"]')!.click()
    await waitFor(() => expect(state.setGroupVisibility).toEqual([["pi/openai", false, 2]]))
  })

  test("a harness that is its own provider answers for its models from the tab row", async () => {
    state.harnessModels.claude = [{ id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }]
    mount()
    await waitFor(() => expect(section("claude")).not.toBeNull())
    await showModels("claude")
    await waitFor(() => expect(browseRows("claude")).toHaveLength(2))
    section("claude")!
      .querySelector<HTMLButtonElement>('[data-component="models-harness-tabs"] [data-action="settings-models-group-toggle-all"]')!
      .click()
    await waitFor(() => expect(state.setGroupVisibility).toEqual([["claude", false, 2]]))
  })

  test("a provider with more than ten models shows ten and asks for a search beyond them", async () => {
    state.harnessModels.codex = Array.from({ length: 12 }, (_, index) => ({ id: `gpt-${index}`, name: `GPT ${String(index).padStart(2, "0")}` }))
    mount()
    await waitFor(() => expect(section("codex")).not.toBeNull())
    await showModels("codex")
    await waitFor(() => expect(browseRows("codex")).toHaveLength(10))
    expect(section("codex")?.textContent).toContain("settings.models.providerSearch.hint:10|12")
    expect(state.optionRequests).toContainEqual({ directory: "/repo", harness: "codex" })
  })

  test("a harness names vendors it holds no credential for; those are off and reached only by search", async () => {
    state.harnessModels.pi = [
      { id: "openai/gpt-5.4", name: "GPT-5.4", connected: true },
      { id: "amazon-bedrock/nova-lite", name: "Nova Lite", connected: false },
    ]
    mount()
    await waitFor(() => expect(section("pi")).not.toBeNull())
    await showModels("pi")
    await waitFor(() => expect(groups("pi")).toHaveLength(2))
    expect(groupCounts("pi")).toEqual([
      "Openaisettings.models.group.count:1|1settings.models.group.disableAll",
      "Amazon Bedrocksettings.providers.status.notConnectedsettings.models.group.count:0|1settings.models.group.enableAll",
    ])
    expect(section("pi")?.textContent).toContain("settings.models.enabled.count:1")
    // Switching the unreachable vendor on is the user's to make, per vendor.
    groups("pi")[1].querySelector<HTMLButtonElement>('[data-action="settings-models-group-toggle-all"]')!.click()
    await waitFor(() => expect(state.setGroupVisibility).toEqual([["pi/amazon-bedrock", true, 1]]))
  })

  test("a harness that reports nothing, or fails, says so in its own section", async () => {
    state.failing = { harness: "pi", message: "Unsupported Pi version 0.85.1" }
    mount()
    await waitFor(() => expect(section("cursor")).not.toBeNull())
    await showModels("cursor")
    await showModels("pi")
    await waitFor(() => expect(section("cursor")?.textContent).toContain("settings.models.harness.empty:Cursor|main"))
    await waitFor(() => expect(section("pi")?.textContent).toContain("Unsupported Pi version 0.85.1"))
  })
})

describe("Settings → Models provider search", () => {
  test("a harness with more vendors than fit lists the reachable ones and finds the rest by search", async () => {
    state.harnessModels.pi = Array.from({ length: 30 }, (_, index) => ({
      id: `vendor-${index}/model`,
      name: `Model ${index}`,
      connected: index === 0,
    }))
    mount()
    await waitFor(() => expect(section("pi")).not.toBeNull())
    await showModels("pi")
    await waitFor(() => expect(groupKeys("pi")).toEqual(["pi/vendor-0"]))
    const search = section("pi")?.querySelector<HTMLInputElement>('input[data-action="settings-models-provider-search"]')
    expect(search).not.toBeNull()
    fireEvent.input(search!, { target: { value: "vendor-17" } })
    await waitFor(() => expect(groupKeys("pi")).toEqual(["pi/vendor-17"]))
  })
})
