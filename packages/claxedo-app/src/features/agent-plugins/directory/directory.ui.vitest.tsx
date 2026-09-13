import { activationSummary, categoryChips, defaultOutcome, directorySections, pluginStatus, skillBody } from "./view"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"

const clients = new Set<QueryClient>()
import type { JSX } from "solid-js"
import {
  agentPluginApi,
  type HarnessActivation,
  type PluginCandidate,
  type PluginSkill,
  type PluginSource,
  type PluginToolGroup,
} from "../api"
import type { AgentPluginConnectionPort } from "../connections"
import { directoryApi } from "./data"
import { AGENT_PLUGIN_PANE_WIDTH_KEY, readPaneWidth, writePaneWidth } from "./pane-width"

// The detail pane renders SKILL.md through the app's shared markdown boundary,
// which drags marked/shiki and its providers into a component test. The
// established pattern in this package is to substitute that one barrel.
vi.mock("@/ui/session-kit", () => ({ Markdown: (props: { text: string }) => <pre>{props.text}</pre> as JSX.Element }))

// Kobalte's menu is portal- and pointer-driven, which a jsdom component test
// cannot open. Substituting it — the established pattern for every other menu
// surface in this package — leaves the menu's CONTENTS as the thing under test,
// which is exactly what the pane's action hierarchy is about.
vi.mock("@opencode-ai/ui/dropdown-menu", () => {
  const Root = (props: { children?: JSX.Element }) => <div>{props.children}</div>
  return {
    DropdownMenu: Object.assign(Root, {
      Trigger: (props: { children?: JSX.Element; "aria-label"?: string }) => (
        <button type="button" aria-label={props["aria-label"]}>{props.children}</button>
      ),
      Portal: (props: { children?: JSX.Element }) => <>{props.children}</>,
      Content: (props: { children?: JSX.Element }) => <div>{props.children}</div>,
      Item: (props: { children?: JSX.Element; disabled?: boolean; onSelect?: () => void }) => (
        <div
          role="menuitem"
          aria-disabled={props.disabled === true}
          onClick={() => {
            if (!props.disabled) props.onSelect?.()
          }}
        >
          {props.children}
        </div>
      ),
    }),
  }
})

const BASE = "https://control.example"

const activation = (effective: boolean, organizationDefault = false): HarnessActivation => ({
  explicit: null,
  projectOverride: null,
  userDefault: null,
  organizationDefault,
  claxedoDefault: false,
  effective: { status: "ready", effective, winner: "user-default", artifactDigest: "sha256:retained" },
})

/** The same activation on every supported harness; the fixtures never differ per harness. */
const everyHarness = (state: HarnessActivation): PluginCandidate["harnesses"] =>
  ({ opencode: state, claude: state, codex: state, cursor: state })

const harnesses = (effective: boolean, organizationDefault = false) =>
  everyHarness(activation(effective, organizationDefault))

const CLAXEDO: PluginSource = { id: "claxedo", kind: "claxedo", label: "Claxedo", repository: "kyashrathore/plugins" }
const ACME: PluginSource = { id: "src-acme", kind: "personal", label: "acme/agent-plugins", repository: "acme/agent-plugins" }

function candidate(input: {
  name: string
  installed: boolean
  source: PluginSource
  retained?: boolean
  updateAvailable?: boolean
  mcpServers?: PluginCandidate["mcpServers"]
  skills?: PluginSkill[]
  description?: string
  categories?: string[]
  featured?: boolean
}): PluginCandidate {
  return {
    pluginInstanceId: `["${input.source.id}","${input.name}"]`,
    sourceId: input.source.id,
    sourceKind: input.source.kind,
    source: input.source,
    icon: { kind: "monogram", text: input.name.slice(0, 2).toUpperCase() },
    ...(input.categories ? { categories: input.categories } : {}),
    ...(input.featured ? { featured: true } : {}),
    skills: input.skills ?? [],
    sourceRevision: "main",
    relativePath: `catalog/${input.name}/plugin.json`,
    candidateDigest: "sha256:candidate",
    sourceAvailable: true,
    retainedDigest: input.retained === false ? null : input.installed || input.retained ? "sha256:retained" : null,
    updateAvailable: input.updateAvailable ?? false,
    manifest: { name: input.name, version: "1.0.0", description: input.description ?? `${input.name} plugin` },
    componentDiagnostics: [],
    mcpServers: input.mcpServers ?? [],
    harnesses: harnesses(input.installed),
  }
}

const OAUTH: PluginCandidate["mcpServers"][number] = {
  name: "knowledge",
  type: "streamable-http",
  authentication: { state: "oauth", integrationId: "mcp-knowledge" },
}
const PUBLIC: PluginCandidate["mcpServers"][number] = {
  name: "docs-http",
  type: "streamable-http",
  authentication: { state: "public" },
}

function sourcedCandidates(): PluginCandidate[] {
  return [
    candidate({ name: "composio", installed: true, source: CLAXEDO, mcpServers: [OAUTH] }),
    candidate({
      name: "context7",
      installed: true,
      source: CLAXEDO,
      updateAvailable: true,
      mcpServers: [PUBLIC],
      skills: [{ name: "docs-lookup", description: "Resolve a library id.", path: "skills/docs-lookup" }],
    }),
    candidate({ name: "posthog", installed: false, source: CLAXEDO }),
    candidate({ name: "granola", installed: false, source: ACME, description: "Your meetings in your workflow." }),
    candidate({ name: "clangd", installed: false, source: CLAXEDO, retained: true }),
  ]
}

/**
 * The first-party server as the catalog serves it: the eight registered groups
 * with their real tool names, in the registration order the route emits.
 *
 * Documents is off here because this fixture is a hosted catalog, where the
 * documents service is the account's rather than the process serving the
 * session; Tasks is off in every deployment until it is asked for.
 */
const BUILT_IN_GROUPS: PluginToolGroup[] = [
  {
    id: "attention",
    enabled: true,
    tools: ["sessions_board", "permission_reply", "question_reply", "question_reject", "wait_for_attention"],
  },
  { id: "documents", enabled: false, tools: ["documents_list", "documents_open"] },
  { id: "processes", enabled: true, tools: ["processes", "process_start", "process_stop", "process_logs"] },
  { id: "review", enabled: true, tools: ["session_changes"] },
  {
    id: "sessions",
    enabled: true,
    tools: [
      "session_create",
      "sessions_list",
      "session_get",
      "session_transcript",
      "session_send",
      "session_abort",
      "session_handoff",
      "session_rename",
      "session_delete",
    ],
  },
  {
    id: "subagents",
    enabled: true,
    tools: ["subagent_capabilities", "create_subagent", "subagent_status", "subagent_list", "subagent_cancel"],
  },
  { id: "tasks", enabled: false, tools: ["task_list", "task_get", "task_create", "task_start"] },
  {
    id: "workspaces",
    enabled: true,
    tools: ["workspaces_list", "workspace_status", "workspace_checkpoint", "workspace_restore", "workspace_lifecycle"],
  },
].map((group) => ({ ...group, pluginInstanceId: `claxedo:${group.id}` }))

type BuiltInOverrides = {
  groups?: PluginToolGroup[]
  installed?: boolean
  /** A Claxedo-owned entry is what makes the organization-default items eligible. */
  sourceKind?: PluginCandidate["sourceKind"]
  updateAvailable?: boolean
}

function builtInCandidate(overrides: BuiltInOverrides = {}): PluginCandidate {
  return {
    pluginInstanceId: "claxedo",
    builtIn: true,
    groups: overrides.groups ?? BUILT_IN_GROUPS,
    sourceId: null,
    sourceKind: overrides.sourceKind ?? null,
    source: null,
    icon: { kind: "monogram", text: "CX" },
    skills: [],
    sourceRevision: null,
    relativePath: null,
    candidateDigest: null,
    sourceAvailable: false,
    retainedDigest: null,
    updateAvailable: overrides.updateAvailable ?? false,
    manifest: {
      name: "claxedo",
      description: "Claxedo's own tools, served by the process that runs your sessions.",
    },
    componentDiagnostics: [],
    // The built-in also serves each group as a local MCP server; the pane must
    // read the groups rather than these rows.
    mcpServers: (overrides.groups ?? BUILT_IN_GROUPS).map((group) => ({
      name: group.id,
      type: "streamable-http" as const,
      authentication: { state: "local" as const },
    })),
    harnesses: harnesses(overrides.installed ?? true),
  }
}

/** The catalog serves the built-in last, as the route does; nothing may find it by index. */
function withBuiltIn(overrides: BuiltInOverrides = {}) {
  return { candidates: [...sourcedCandidates(), builtInCandidate(overrides)] }
}

function catalogBody(overrides: Record<string, unknown> = {}) {
  return {
    revision: 4,
    supportedHarnesses: ["opencode", "claude", "codex", "cursor"],
    projects: [{ id: "project-1", label: "Project One" }],
    selectedProjectId: null,
    canManageOrganizationDefaults: true,
    canManageOrganizationConnections: true,
    candidates: sourcedCandidates(),
    errors: [],
    ...overrides,
  }
}

const SOURCES = {
  sources: [
    { ...CLAXEDO, ref: "main", canRemove: false },
    { ...ACME, ref: "main", canRemove: true },
  ],
}

const MACHINE = {
  harnesses: [
    {
      harnessId: "cursor",
      entries: [
        { name: "figma", root: "~/.cursor/plugins/local/figma", ownedByClaxedo: false },
        { name: "context7", root: "~/.cursor/plugins/local/claxedo-context7", ownedByClaxedo: true },
      ],
    },
  ],
  skills: [
    { name: "pdf", harnessId: "claude", root: "~/.claude/skills/pdf" },
    { name: "review", harnessId: "agents", root: "~/.agents/skills/review" },
  ],
}

type Recorded = { url: string; method: string; body?: unknown }

function harness(options: {
  connectionsError?: Error
  catalog?: Record<string, unknown>
  sourceAdd?: { status: number; body: unknown }
  skill?: { status: number; body: unknown }
  connections?: Array<{ id: string; integrationId: string; scope: "personal" | "team"; status: "connected" | "degraded" | "broken" }>
  /** Held open so a mutation's pending state is observable while it is in flight. */
  activationGate?: Promise<void>
} = {}) {
  const recorded: Recorded[] = []
  // Every write moves the catalog on, the way the route does, so a caller that
  // reuses one revision across several posts is caught rather than tolerated.
  let revision = 4
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(requestUrl(input))
    const method = init?.method ?? "GET"
    const body = requestJson(init)
    recorded.push({ url: url.pathname, method, ...(body !== undefined ? { body } : {}) })
    if (url.pathname === "/api/claxedo/plugins" || url.pathname === "/api/claxedo/plugins/refresh") {
      return Response.json(catalogBody(options.catalog))
    }
    if (url.pathname === "/api/claxedo/plugins/sources" && method === "GET") return Response.json(SOURCES)
    if (url.pathname.startsWith("/api/claxedo/plugins/sources/") && method === "DELETE") return new Response(null, { status: 204 })
    if (url.pathname === "/api/claxedo/plugins/sources" && method === "POST") {
      const answer = options.sourceAdd ?? { status: 201, body: { source: { ...ACME, ref: "main", canRemove: true }, plugins: 1 } }
      return Response.json(answer.body, { status: answer.status })
    }
    if (url.pathname === "/api/claxedo/plugins/machine-installed") return Response.json(MACHINE)
    if (url.pathname.startsWith("/api/claxedo/plugins/") && url.pathname.includes("/skills/")) {
      const answer = options.skill ?? {
        status: 200,
        body: { name: "docs-lookup", description: "Resolve a library id.", markdown: "# Steps\nresolve-library-id" },
      }
      return Response.json(answer.body, { status: answer.status })
    }
    if (method === "POST") {
      if (options.activationGate) await options.activationGate
      revision += 1
      return Response.json({ revision, reconciliation: { state: "applied" } })
    }
    throw new Error(`unexpected request ${url}`)
  })
  const open = vi.fn<AgentPluginConnectionPort["open"]>()
  const disconnect = vi.fn<AgentPluginConnectionPort["disconnect"]>(async () => {})
  const port: AgentPluginConnectionPort = {
    load: async () => {
      if (options.connectionsError) throw options.connectionsError
      return { connections: options.connections ?? [] }
    },
    open,
    disconnect,
  }
  return { recorded, fetchMock, port, open, disconnect }
}

async function renderDirectory(options: Parameters<typeof harness>[0] & {
  mode?: "signed" | "unsigned"
  client?: QueryClient
  context?: ReturnType<typeof harness>
} = {}) {
  const context = options.context ?? harness(options)
  const onAdd = vi.fn(async () => {})
  const client = options.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.add(client)
  const { AgentPluginDirectory } = await import("./directory")
  render(() => (
    <QueryClientProvider client={client}>
      <DialogProvider>
        <AgentPluginDirectory
          mode={options.mode ?? "signed"}
          api={agentPluginApi({ baseUrl: BASE, request: context.fetchMock })}
          directory={directoryApi({ baseUrl: BASE, request: context.fetchMock })}
          connections={context.port}
          onAdd={onAdd}
        />
      </DialogProvider>
    </QueryClientProvider>
  ))
  await screen.findByRole("button", { name: "composio" })
  return { ...context, onAdd, client }
}

function catalogReads(recorded: Recorded[]) {
  return recorded.filter((entry) => entry.method === "GET" && entry.url === "/api/claxedo/plugins")
}

function catalogRefreshes(recorded: Recorded[]) {
  return recorded.filter((entry) => entry.method === "GET" && entry.url === "/api/claxedo/plugins/refresh")
}

async function openPane(name: string) {
  await fireEvent.click(screen.getByRole("button", { name }))
  return await screen.findByRole("complementary", { name: `${name} details` })
}

/**
 * Answer the confirm the Directory raises before a destructive action.
 *
 * The dialog host disposes a closed dialog on a timer, and its element lives in
 * a portal under `document.body` that `cleanup()` does not reach — so every
 * answer waits the dialog out rather than leaving it for the next test to find.
 */
async function answerConfirm(label: string) {
  const dialog = await screen.findByRole("dialog")
  await fireEvent.click(within(dialog).getByRole("button", { name: label }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
}

const posted = (recorded: Recorded[], path: string) => recorded.filter((entry) => entry.url === path && entry.method === "POST")

afterEach(() => {
  cleanup()
  for (const client of clients) client.clear()
  clients.clear()
  localStorage.clear()
})

describe("Agent Plugin Directory sections", () => {
  test("splits candidates into needs attention, installed, source and personal sections", async () => {
    await renderDirectory()

    const attention = screen.getByRole("region", { name: "Needs attention" })
    expect(within(attention).getByRole("button", { name: "composio" })).toBeVisible()
    expect(within(attention).getByText("Needs authentication")).toBeVisible()

    const installed = screen.getByRole("region", { name: "Installed" })
    expect(within(installed).getByRole("button", { name: "context7" })).toBeVisible()
    expect(within(installed).queryByRole("button", { name: "composio" })).toBeNull()

    const claxedo = screen.getByRole("region", { name: "Claxedo" })
    expect(within(claxedo).getByRole("button", { name: "posthog" })).toBeVisible()
    expect(within(claxedo).getByRole("button", { name: "clangd" })).toBeVisible()

    const acme = screen.getByRole("region", { name: "acme/agent-plugins" })
    expect(within(acme).getByRole("button", { name: "granola" })).toBeVisible()

    const personal = await screen.findByRole("region", { name: "Personal" })
    expect(within(personal).getByText("figma")).toBeVisible()
    // The Claxedo adapters' own marker entry is not the user's install.
    expect(within(personal).queryByText("context7")).toBeNull()
  })

  test("no card shows a plugin's path; the path is the row's title instead", async () => {
    await renderDirectory()
    await screen.findByRole("region", { name: "Personal" })

    for (const card of document.querySelectorAll("[data-agent-plugin-card]")) {
      expect(card.textContent).not.toContain("catalog/")
    }
    const personalRow = document.querySelector("[data-agent-plugin-personal='figma']")
    expect(personalRow?.textContent).not.toContain("~/.cursor")
    expect(personalRow?.getAttribute("title")).toBe("~/.cursor/plugins/local/figma")
    expect(document.querySelector("[data-agent-plugin-card]")?.getAttribute("title")).toContain("catalog/")
    // The section title already says whose installs these are.
    expect(screen.queryByText("Installed by you")).toBeNull()
  })

  test("an installed plugin reports its harness count as muted status, not a green pill", async () => {
    await renderDirectory({
      connections: [{ id: "c1", integrationId: "mcp-knowledge", scope: "personal", status: "connected" }],
    })

    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull())
    const installed = screen.getByRole("region", { name: "Installed" })
    expect(within(installed).getByRole("button", { name: "composio" })).toBeVisible()
    expect(within(installed).getByText("Installed · 4 harnesses")).toBeVisible()
    expect(screen.queryByText("Installed ✓")).toBeNull()
  })

  test("search matches a skill name and hides everything else", async () => {
    await renderDirectory()

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search plugins" }), { target: { value: "docs-lookup" } })

    expect(screen.getByRole("button", { name: "context7" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "composio" })).toBeNull()
    expect(screen.queryByRole("button", { name: "granola" })).toBeNull()
  })

  test("a source chip narrows the sections to that source", async () => {
    await renderDirectory()

    await fireEvent.click(screen.getByRole("tab", { name: /acme\/agent-plugins/ }))

    expect(screen.getByRole("button", { name: "granola" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "posthog" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Personal" })).toBeNull()
  })

  test("the add-source form is closed until it is asked for", async () => {
    await renderDirectory()

    expect(screen.queryByRole("form", { name: "Add source" })).toBeNull()
    await fireEvent.click(screen.getByRole("button", { name: "+ Add source" }))
    expect(screen.getByRole("form", { name: "Add source" })).toBeVisible()
  })

  test("the example repository in the add-source hint opens on GitHub", async () => {
    await renderDirectory()
    await fireEvent.click(screen.getByRole("button", { name: "+ Add source" }))

    const example = screen.getByRole("link", { name: "kyashrathore/plugins" })
    expect(example).toHaveAttribute("href", "https://github.com/kyashrathore/plugins")
    expect(example).toHaveAttribute("target", "_blank")
    expect(example.closest("p")?.textContent).toContain("optional .mcp.json")
  })
})

const CATEGORIZED = {
  candidates: [
    candidate({ name: "composio", installed: true, source: CLAXEDO, categories: ["mcp-servers"] }),
    candidate({ name: "posthog", installed: false, source: CLAXEDO, categories: ["data-and-analytics"], featured: true }),
    candidate({ name: "granola", installed: false, source: ACME, categories: ["productivity"] }),
    candidate({ name: "clangd", installed: false, source: CLAXEDO }),
  ],
}

describe("Agent Plugin Directory categories and Featured", () => {
  test("a catalog with no declared category earns no chip row", async () => {
    await renderDirectory()

    expect(screen.queryByRole("tablist", { name: "Categories" })).toBeNull()
  })

  test("only the categories the catalog declares become chips", async () => {
    await renderDirectory({ catalog: CATEGORIZED })

    const chips = within(await screen.findByRole("tablist", { name: "Categories" }))
      .getAllByRole("tab").map((tab) => tab.textContent)
    expect(chips).toEqual(["All categories", "MCP Servers1", "Data & Analytics1", "Productivity1"])
  })

  test("a category chip narrows the catalog and stands the Featured section down", async () => {
    await renderDirectory({ catalog: CATEGORIZED })
    expect(await screen.findByRole("region", { name: "Featured" })).toBeVisible()

    await fireEvent.click(screen.getByRole("tab", { name: /Productivity/ }))

    expect(screen.getByRole("button", { name: "granola" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "composio" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Featured" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Personal" })).toBeNull()
  })

  test("a featured offer is listed once, under Featured rather than its source", async () => {
    await renderDirectory({ catalog: CATEGORIZED })

    const featured = await screen.findByRole("region", { name: "Featured" })
    expect(within(featured).getByRole("button", { name: "posthog" })).toBeVisible()
    expect(screen.getAllByRole("button", { name: "posthog" })).toHaveLength(1)
    expect(within(screen.getByRole("region", { name: "Claxedo" })).queryByRole("button", { name: "posthog" })).toBeNull()
  })

  test("an installed plugin is never pulled into Featured", () => {
    const sections = directorySections({
      candidates: [candidate({ name: "composio", installed: true, source: CLAXEDO, featured: true })],
      sources: [{ id: CLAXEDO.id, label: CLAXEDO.label }],
      query: "",
      filter: "all",
    })

    expect(sections.map((section) => section.id)).toEqual(["installed"])
  })

  test("a category no candidate declares earns no chip", () => {
    expect(categoryChips(CATEGORIZED.candidates).map((chip) => chip.id))
      .toEqual(["mcp-servers", "data-and-analytics", "productivity"])
  })
})

describe("Agent Plugin Directory catalog cache", () => {
  test("reopening Marketplace revalidates cached activation without refreshing sources", async () => {
    const context = harness()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.add(client)

    await renderDirectory({ client, context })
    expect(catalogReads(context.recorded)).toHaveLength(1)
    expect(catalogRefreshes(context.recorded)).toHaveLength(0)

    cleanup()
    client.setQueryData(["controlPlane", "signed", "agentPlugins", null], catalogBody({
      candidates: [candidate({ name: "composio", installed: false, source: CLAXEDO })],
    }))
    await renderDirectory({ client, context })
    const pane = await openPane("composio")
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Disable", exact: true })).toBeVisible())
    expect(catalogReads(context.recorded)).toHaveLength(2)
    expect(catalogRefreshes(context.recorded)).toHaveLength(0)

    await fireEvent.click(screen.getByRole("button", { name: "Refresh catalog" }))
    await waitFor(() => expect(catalogRefreshes(context.recorded)).toHaveLength(1))
    expect(catalogReads(context.recorded)).toHaveLength(2)
  })
})

describe("Agent Plugin Directory detail pane", () => {
  test("arrow keys walk the cards", async () => {
    await renderDirectory()

    const first = screen.getByRole("button", { name: "composio" })
    first.focus()
    await fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowDown" })

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "context7" }))

    await fireEvent.keyDown(screen.getByRole("main"), { key: "ArrowUp" })
    expect(document.activeElement).toBe(first)
  })

  test("a card opens the pane and Escape closes it", async () => {
    await renderDirectory()

    const pane = await openPane("context7")
    expect(within(pane).getByText("docs-lookup")).toBeVisible()
    expect(within(pane).getByText("Enabled · your choice")).toBeVisible()

    await fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "context7 details" })).toBeNull())
  })

  test("the facts strip answers status, where, projects and harnesses above the description", async () => {
    await renderDirectory()
    const pane = await openPane("context7")

    const facts = pane.querySelector("[data-component='agent-plugin-facts']")!
    expect(within(facts as HTMLElement).getByText("Enabled · your choice")).toBeVisible()
    expect(within(facts as HTMLElement).getByText("Local")).toBeVisible()
    expect(within(facts as HTMLElement).getByText("Cross-project default")).toBeVisible()
    expect(within(facts as HTMLElement).getByText("opencode")).toBeVisible()
    // The strip precedes the prose it gives context to.
    expect(facts.compareDocumentPosition(within(pane).getByText("context7 plugin")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test("an uninstalled plugin's skill reads SKILL.md from the catalog", async () => {
    const { recorded } = await renderDirectory({
      catalog: {
        candidates: catalogBody().candidates.map((plugin) =>
          plugin.manifest?.name === "granola"
            ? { ...plugin, skills: [{ name: "meeting-notes", description: "Capture meetings.", path: "skills/meeting-notes" }] }
            : plugin
        ),
      },
    })
    const pane = await openPane("granola")

    await fireEvent.click(within(pane).getByRole("button", { name: /meeting-notes/ }))

    await waitFor(() => expect(recorded.some((entry) =>
      entry.url === `/api/claxedo/plugins/${encodeURIComponent('["src-acme","granola"]')}/skills/meeting-notes`)).toBe(true))
    const crumbs = await within(pane).findByRole("navigation", { name: "Breadcrumb" })
    expect(within(crumbs).getByText("granola")).toBeVisible()
    expect(within(crumbs).getByText("meeting-notes")).toBeVisible()
    await waitFor(() => expect(within(pane).getByText(/resolve-library-id/)).toBeVisible())
  })

  test("clicking a skill navigates the pane to the skill, and the breadcrumb comes back", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: /docs-lookup/ }))

    await waitFor(() => expect(recorded.some((entry) =>
      entry.url === `/api/claxedo/plugins/${encodeURIComponent('["claxedo","context7"]')}/skills/docs-lookup`)).toBe(true))
    const crumbs = await within(pane).findByRole("navigation", { name: "Breadcrumb" })
    expect(within(crumbs).getByText("context7")).toBeVisible()
    expect(within(crumbs).getByText("docs-lookup")).toBeVisible()
    await waitFor(() => expect(within(pane).getByText(/resolve-library-id/)).toBeVisible())
    // The plugin view is replaced, not pushed underneath.
    expect(within(pane).queryByRole("button", { name: "Disable" })).toBeNull()

    await fireEvent.click(within(pane).getByRole("button", { name: "Back to context7" }))
    expect(within(pane).getByRole("button", { name: "Disable" })).toBeVisible()
  })

  test("Escape in the skill view returns to the plugin instead of closing the pane", async () => {
    await renderDirectory()
    const pane = await openPane("context7")
    await fireEvent.click(within(pane).getByRole("button", { name: /docs-lookup/ }))
    await within(pane).findByRole("navigation", { name: "Breadcrumb" })

    await fireEvent.keyDown(pane, { key: "Escape" })

    expect(screen.getByRole("complementary", { name: "context7 details" })).toBeVisible()
    expect(within(pane).queryByRole("navigation", { name: "Breadcrumb" })).toBeNull()

    await fireEvent.keyDown(pane, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "context7 details" })).toBeNull())
  })

  test("the pane opens at the remembered width and its handle resizes with the keyboard", async () => {
    localStorage.setItem(AGENT_PLUGIN_PANE_WIDTH_KEY, "500")
    await renderDirectory()
    const pane = await openPane("context7")

    expect(pane.style.width).toBe("500px")

    const handle = within(pane).getByRole("separator", { name: "Resize plugin details" })
    await fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(pane.style.width).toBe("516px")
    expect(localStorage.getItem(AGENT_PLUGIN_PANE_WIDTH_KEY)).toBe("516")

    await fireEvent.keyDown(handle, { key: "End" })
    expect(pane.style.width).toBe("360px")
  })
})

describe("Agent Plugin Directory actions", () => {
  test("Enable posts activation with choice true, every harness and the project target", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("clangd")

    await fireEvent.click(within(pane).getByRole("button", { name: "Enable" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0].body).toEqual({
      pluginInstanceId: '["claxedo","clangd"]',
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: true,
      expectedRevision: 4,
      target: { scope: "projects", projectIds: ["project-1"] },
    })
  })

  test("Disable posts activation with choice false", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: "Disable" }))
    await answerConfirm("Disable")

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0].body).toMatchObject({
      pluginInstanceId: '["claxedo","context7"]',
      choice: false,
      expectedRevision: 4,
    })
  })

  test("the overflow menu carries every secondary action and names what clearing would do", async () => {
    await renderDirectory()
    const pane = await openPane("context7")

    const items = within(pane).getAllByRole("menuitem").map((item) => item.textContent)
    expect(items[0]).toContain("Clear my override")
    expect(items[0]).toContain("Follow the organization default — it would be disabled")
    expect(items.slice(1)).toEqual([
      "Make organization default (admin)",
      "Update to 1.0.0",
    ])
    // The main row keeps exactly one button; the rest are menu items.
    expect(within(pane).queryByRole("button", { name: "Use default" })).toBeNull()
    expect(within(pane).queryByRole("button", { name: /organization/ })).toBeNull()
  })

  test("Clear my override posts activation with choice null", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("menuitem", { name: /Clear my override/ }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0].body).toMatchObject({ choice: null })
  })

  test("Update posts the user authority when signed", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("menuitem", { name: "Update to 1.0.0" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/update")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/update")[0].body).toEqual({
      pluginInstanceId: '["claxedo","context7"]',
      expectedRevision: 4,
      authority: "user",
    })
  })

  test("Make organization default posts the positive organization default", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("menuitem", { name: "Make organization default (admin)" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/organization-default")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/organization-default")[0].body).toEqual({
      pluginInstanceId: '["claxedo","context7"]',
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: true,
      expectedRevision: 4,
    })
  })

  test("Connect is the row's one button; the organization scope lives in its menu", async () => {
    const { open } = await renderDirectory()
    const pane = await openPane("composio")

    await fireEvent.click(within(pane).getByRole("button", { name: "Connect" }))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: "mcp-knowledge",
      name: "knowledge MCP",
      scope: "personal",
      teamScopeEnabled: true,
    }))

    await fireEvent.click(within(pane).getByRole("menuitem", { name: "Connect for organization (admin)" }))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ integrationId: "mcp-knowledge", scope: "team" }))
  })

  test("Disconnect calls the connection port with the connection id", async () => {
    const { disconnect } = await renderDirectory({
      connections: [{ id: "conn-1", integrationId: "mcp-knowledge", scope: "personal", status: "connected" }],
    })
    const pane = await openPane("composio")

    await fireEvent.click(await within(pane).findByRole("menuitem", { name: "Disconnect" }))
    await answerConfirm("Disconnect")

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("conn-1"))
  })
})

describe("Agent Plugin Directory destructive confirmation", () => {
  test("Disable names what it removes and posts nothing until it is confirmed", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: "Disable" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Disable context7?")).toBeVisible()
    expect(within(dialog).getByText("This removes its config and materialized files.")).toBeVisible()

    await answerConfirm("Cancel")

    expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(0)
  })

  test("Enable is not destructive, so it never raises a confirm", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("clangd")

    await fireEvent.click(within(pane).getByRole("button", { name: "Enable" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  test("cancelling Disconnect leaves the connection alone", async () => {
    const { disconnect } = await renderDirectory({
      connections: [{ id: "conn-1", integrationId: "mcp-knowledge", scope: "personal", status: "connected" }],
    })
    const pane = await openPane("composio")

    await fireEvent.click(await within(pane).findByRole("menuitem", { name: "Disconnect" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Disconnect knowledge?")).toBeVisible()
    await answerConfirm("Cancel")

    expect(disconnect).not.toHaveBeenCalled()
  })

  test("cancelling Remove source deletes nothing", async () => {
    const { recorded } = await renderDirectory()

    await fireEvent.click(screen.getByRole("tab", { name: /acme\/agent-plugins/ }))
    await fireEvent.click(screen.getByRole("button", { name: "Remove acme/agent-plugins" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Remove acme/agent-plugins?")).toBeVisible()
    await answerConfirm("Cancel")

    expect(recorded.some((entry) => entry.method === "DELETE")).toBe(false)
  })
})

describe("Agent Plugin Directory unsigned mode", () => {
  test("hides the project scope and every organization action", async () => {
    await renderDirectory({ mode: "unsigned" })

    expect(screen.queryByLabelText("Inspect effective state for")).toBeNull()

    await fireEvent.click(screen.getByRole("button", { name: "context7" }))
    const pane = await screen.findByRole("complementary", { name: "context7 details" })
    expect(within(pane).queryByRole("menuitem", { name: /\(admin\)$/ })).toBeNull()
    expect(within(pane).getByText("Every project on this machine")).toBeVisible()
  })

  test("Disable on the unsigned rail posts no project target", async () => {
    const { recorded } = await renderDirectory({ mode: "unsigned" })
    await fireEvent.click(screen.getByRole("button", { name: "context7" }))
    const pane = await screen.findByRole("complementary", { name: "context7 details" })

    await fireEvent.click(within(pane).getByRole("button", { name: "Disable" }))
    await answerConfirm("Disable")

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0].body).toEqual({
      pluginInstanceId: '["claxedo","context7"]',
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: false,
      expectedRevision: 4,
    })
  })
})

describe("Agent Plugin Directory built-in server", () => {
  test("the built-in is a card marked built in, whose status names the groups on for this project", async () => {
    await renderDirectory({ catalog: withBuiltIn() })

    const card = document.querySelector<HTMLElement>("[data-agent-plugin-card=\"claxedo\"]")!
    expect(within(card).getByText("Built in")).toBeTruthy()
    expect(within(card).getByText(
      "On for this project: sessions, subagents, attention, processes, review, workspaces",
    )).toBeTruthy()
  })

  test("a built-in that is off is never offered for install, and is restored rather than enabled", async () => {
    // A sourced candidate in this state — no retained bytes, no reachable
    // source — earns a disabled "Add" on its card. The built-in earns nothing.
    await renderDirectory({ catalog: withBuiltIn({ installed: false }) })

    const card = document.querySelector<HTMLElement>("[data-agent-plugin-card=\"claxedo\"]")!
    expect(within(card).queryByRole("button", { name: "Add" })).toBeNull()
    expect(within(card).queryByRole("button", { name: "Enable" })).toBeNull()

    const pane = await openPane("claxedo")
    expect(within(pane).queryByRole("button", { name: "Add" })).toBeNull()
    // Never "Enable": restoring leaves Tasks off, which an Enable label would
    // promise it had turned on.
    expect(within(pane).queryByRole("button", { name: "Enable" })).toBeNull()
    expect(within(pane).getByRole("button", { name: "Restore defaults" })).not.toBeDisabled()
    // `sourceAvailable: false` is how the built-in says it has no source at
    // all, not that the source it has went missing.
    expect(within(pane).queryByText(/Source unavailable/)).toBeNull()
    expect(within(pane).getByText("Built in")).toBeTruthy()
  })

  test("the built-in's overflow menu offers only the item that follows the default", async () => {
    // The two conditions that add items to a sourced plugin's menu: Claxedo
    // ownership makes the organization defaults eligible, and an available
    // update earns its own row. The built-in has neither an organization to
    // hand itself to nor an artifact to take.
    await renderDirectory({ catalog: withBuiltIn({ sourceKind: "claxedo", updateAvailable: true }) })
    const pane = await openPane("claxedo")

    expect(within(pane).getByRole("button", { name: "Disable" })).toBeTruthy()
    expect(within(pane).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Restore defaults"),
    ])
  })

  test("the pane's server list is one row per tool group, with a switch and the group's tool names", async () => {
    await renderDirectory({ catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    const groups = within(pane).getByRole("region", { name: "claxedo tool groups" })
    expect(within(groups).getByRole("heading").textContent).toContain("Tool groups")

    // The catalog emits registration order; the pane reads in the order the
    // product decided.
    expect([...groups.querySelectorAll<HTMLElement>("[data-agent-plugin-tool-group]")]
      .map((row) => row.dataset.agentPluginToolGroup))
      .toEqual(["sessions", "subagents", "attention", "processes", "documents", "tasks", "review", "workspaces"])

    const tasks = groups.querySelector<HTMLElement>("[data-agent-plugin-tool-group=\"tasks\"]")!
    expect(within(tasks).getByText("task_list, task_get, task_create, task_start")).toBeTruthy()
    expect(within(tasks).getByRole("switch", { name: "tasks" })).not.toBeChecked()
    expect(within(groups).getByRole("switch", { name: "sessions" })).toBeChecked()

    expect(within(groups).getByText("Changes apply to sessions started from now.")).toBeTruthy()
  })

  test("a switch writes the group's activation for this project", async () => {
    const { recorded } = await renderDirectory({ catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getByRole("switch", { name: "tasks" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0].body).toEqual({
      pluginInstanceId: "claxedo:tasks",
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: true,
      expectedRevision: 4,
      target: { scope: "projects", projectIds: ["project-1"] },
    })
  })

  test("turning a group off writes choice false without the confirm a whole plugin needs", async () => {
    const { recorded } = await renderDirectory({ catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getByRole("switch", { name: "sessions" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0].body).toMatchObject({
      pluginInstanceId: "claxedo:sessions",
      choice: false,
    })
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  test("a group in flight shows the same pending state the Enable button shows", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const context = harness({ catalog: withBuiltIn(), activationGate: gate })
    await renderDirectory({ context, catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getByRole("switch", { name: "tasks" }))

    await waitFor(() => expect(within(pane).getByRole("button", { name: "Applying…" })).toBeTruthy())
    expect(within(pane).getByRole("switch", { name: "sessions" })).toBeDisabled()

    release()
    await waitFor(() => expect(within(pane).getByRole("button", { name: "Disable" })).toBeTruthy())
    expect(within(pane).getByRole("switch", { name: "sessions" })).not.toBeDisabled()
  })

  test("Disable turns every group off, because \"claxedo\" is not an activation subject", async () => {
    const { recorded } = await renderDirectory({ catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getByRole("button", { name: "Disable" }))
    await answerConfirm("Turn off")

    const posts = () => posted(recorded, "/api/claxedo/plugins/activation")
    await waitFor(() => expect(posts()).toHaveLength(8))
    expect(posts().map((post) => (post.body as { pluginInstanceId: string }).pluginInstanceId)).toEqual([
      "claxedo:sessions",
      "claxedo:subagents",
      "claxedo:attention",
      "claxedo:processes",
      "claxedo:documents",
      "claxedo:tasks",
      "claxedo:review",
      "claxedo:workspaces",
    ])
    expect(posts().every((post) => (post.body as { choice: unknown }).choice === false)).toBe(true)
    // Each post carries the revision the one before it moved the catalog to.
    expect(posts().map((post) => (post.body as { expectedRevision: number }).expectedRevision))
      .toEqual([4, 5, 6, 7, 8, 9, 10, 11])
  })

  test("Restore defaults clears every group rather than granting Tasks the user never consented to", async () => {
    const { recorded } = await renderDirectory({ catalog: withBuiltIn({ installed: false }) })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getByRole("button", { name: "Restore defaults" }))

    const posts = () => posted(recorded, "/api/claxedo/plugins/activation")
    await waitFor(() => expect(posts()).toHaveLength(8))
    expect(posts().every((post) => (post.body as { choice: unknown }).choice === null)).toBe(true)
    expect(posts().some((post) => (post.body as { choice: unknown }).choice === true)).toBe(false)
  })

  test("Clear my override hands every group back to the default", async () => {
    const { recorded } = await renderDirectory({ catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getAllByRole("menuitem")[0])

    const posts = () => posted(recorded, "/api/claxedo/plugins/activation")
    await waitFor(() => expect(posts()).toHaveLength(8))
    expect(posts().every((post) => (post.body as { choice: unknown }).choice === null)).toBe(true)
  })

  test("no whole-plugin action ever names the built-in candidate itself", async () => {
    const { recorded } = await renderDirectory({ catalog: withBuiltIn() })
    const pane = await openPane("claxedo")

    await fireEvent.click(within(pane).getByRole("button", { name: "Disable" }))
    await answerConfirm("Turn off")
    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(8))

    expect(recorded.some((entry) => entry.method === "POST"
      && (entry.body as { pluginInstanceId?: string } | undefined)?.pluginInstanceId === "claxedo")).toBe(false)
  })

  test("a built-in with every group off says so rather than reporting a harness count", async () => {
    await renderDirectory({
      catalog: withBuiltIn({ groups: BUILT_IN_GROUPS.map((group) => ({ ...group, enabled: false })) }),
    })

    const card = document.querySelector<HTMLElement>("[data-agent-plugin-card=\"claxedo\"]")!
    const status = card.querySelector<HTMLElement>("[data-component=\"agent-plugin-status\"]")!
    expect(status.textContent).toBe("No tool groups on for this project")
    expect(status.dataset.tone).toBe("warning")
  })

  test("a disabled built-in stays beside the installed plugins instead of becoming an unsourced offer", async () => {
    await renderDirectory({ catalog: withBuiltIn({ installed: false }) })

    expect(screen.queryByRole("region", { name: "No longer served by a source" })).toBeNull()
    const installed = screen.getByRole("region", { name: "Installed" })
    expect(within(installed).getByRole("button", { name: "claxedo" })).toBeTruthy()
    const card = document.querySelector<HTMLElement>("[data-agent-plugin-card=\"claxedo\"]")!
    expect(within(card).getByText("Off for this project")).toBeTruthy()
  })

  test("searching a tool name finds the built-in", async () => {
    await renderDirectory({ catalog: withBuiltIn() })

    await fireEvent.input(screen.getByRole("searchbox", { name: "Search plugins" }), { target: { value: "task_create" } })

    await waitFor(() => expect(screen.queryByRole("button", { name: "composio" })).toBeNull())
    expect(screen.getByRole("button", { name: "claxedo" })).toBeTruthy()
  })
})

describe("Agent Plugin Directory sources", () => {
  test("a removable source is only offered while its chip is active", async () => {
    const { recorded } = await renderDirectory()

    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull()
    // The built-in Claxedo collection reports canRemove: false.
    await fireEvent.click(screen.getByRole("tab", { name: /Claxedo/ }))
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull()

    await fireEvent.click(screen.getByRole("tab", { name: /acme\/agent-plugins/ }))
    await fireEvent.click(screen.getByRole("button", { name: "Remove acme/agent-plugins" }))
    await answerConfirm("Remove")

    await waitFor(() => expect(recorded.some((entry) =>
      entry.method === "DELETE" && entry.url === "/api/claxedo/plugins/sources/src-acme")).toBe(true))
  })

  test("a repository that serves no plugin shows the 422 diagnostics inline and adds nothing", async () => {
    const { recorded } = await renderDirectory({
      sourceAdd: {
        status: 422,
        body: {
          error: {
            code: "agent_plugins_source_empty",
            message: "acme/empty@main serves no valid Agent Plugin",
            diagnostics: [{ sourceId: "src", relativePath: "broken", code: "manifest_invalid", message: "unknown key: hooks" }],
          },
        },
      },
    })

    await fireEvent.click(screen.getByRole("button", { name: "+ Add source" }))
    await fireEvent.input(screen.getByLabelText("GitHub repository"), { target: { value: "acme/empty" } })
    await fireEvent.click(screen.getByRole("button", { name: "Add source" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("serves no valid Agent Plugin")
    expect(alert).toHaveTextContent("broken: unknown key: hooks")
    expect(posted(recorded, "/api/claxedo/plugins/sources")).toHaveLength(1)
    expect(screen.getByLabelText("GitHub repository")).toHaveValue("acme/empty")
  })
})

describe("plugin status derivation", () => {
  const plugin = (overrides: Partial<PluginCandidate> = {}): PluginCandidate =>
    ({ ...candidate({ name: "composio", installed: true, source: CLAXEDO }), ...overrides })

  test("an installed plugin counts its harnesses in muted language", () => {
    expect(pluginStatus({ plugin: plugin() })).toEqual({
      label: "Installed · 4 harnesses",
      tone: "normal",
      attention: false,
    })
  })

  test("an unauthenticated OAuth server outranks an available update", () => {
    const needy = plugin({ updateAvailable: true, mcpServers: [OAUTH] })
    expect(pluginStatus({ plugin: needy })).toEqual({
      label: "Needs authentication",
      tone: "warning",
      attention: true,
    })
    expect(pluginStatus({
      plugin: needy,
      connections: [{ id: "c", integrationId: "mcp-knowledge", scope: "personal", status: "broken" }],
    })).toEqual({ label: "Missing credential", tone: "critical", attention: true })
  })

  test("an update on an otherwise healthy plugin is an accent, not a warning", () => {
    expect(pluginStatus({ plugin: plugin({ updateAvailable: true }) })?.tone).toBe("accent")
  })

  test("an uninstalled offer carries no status at all", () => {
    expect(pluginStatus({ plugin: candidate({ name: "posthog", installed: false, source: CLAXEDO }) })).toBeUndefined()
  })

  test("the Status fact names the authority that decided it", () => {
    const winner = (name: string, effective: boolean) => plugin({
      harnesses: {
        opencode: { ...activation(effective), effective: { status: "ready", effective, winner: name } },
        claude: activation(false),
        codex: activation(false),
        cursor: activation(false),
      },
    })
    expect(activationSummary(winner("user-default", true))).toBe("Enabled · your choice")
    expect(activationSummary(winner("project", true))).toBe("Enabled · your choice")
    expect(activationSummary(winner("organization", true))).toBe("Enabled · organization default")
    expect(activationSummary(winner("claxedo", true))).toBe("Enabled · Claxedo default")
    expect(activationSummary(winner("user-default", false))).toBe("Disabled · your choice")
  })

  test("a candidate no authority has spoken about is not installed", () => {
    const untouched = plugin({
      harnesses: everyHarness({ effective: { status: "ready", effective: false, winner: "none" } }),
    })
    expect(activationSummary(untouched)).toBe("Not installed")
  })

  test("clearing an override falls to the organization default, else to Claxedo", () => {
    const harnessIds = ["opencode", "claude", "codex", "cursor"] as const
    const states = (organizationDefault: boolean | undefined, claxedoDefault: boolean) =>
      everyHarness({
        ...(organizationDefault === undefined ? {} : { organizationDefault }),
        claxedoDefault,
        effective: { status: "ready", effective: false, winner: "user-default" },
      })

    expect(defaultOutcome({ plugin: plugin({ harnesses: states(true, false) }), harnesses: harnessIds }))
      .toEqual({ authority: "organization", enabled: true })
    expect(defaultOutcome({ plugin: plugin({ harnesses: states(false, true) }), harnesses: harnessIds }))
      .toEqual({ authority: "organization", enabled: false })
    expect(defaultOutcome({ plugin: plugin({ harnesses: states(undefined, true) }), harnesses: harnessIds }))
      .toEqual({ authority: "Claxedo", enabled: true })
    expect(defaultOutcome({ plugin: plugin({ harnesses: states(undefined, false) }), harnesses: harnessIds }))
      .toEqual({ authority: "Claxedo", enabled: false })
  })
})

describe("detail pane width", () => {
  test("a stored width survives a round trip and a short one falls back to the default", () => {
    writePaneWidth(512.4)
    expect(localStorage.getItem(AGENT_PLUGIN_PANE_WIDTH_KEY)).toBe("512")
    expect(readPaneWidth()).toBe(512)

    localStorage.setItem(AGENT_PLUGIN_PANE_WIDTH_KEY, "12")
    expect(readPaneWidth()).toBe(420)
    localStorage.setItem(AGENT_PLUGIN_PANE_WIDTH_KEY, "not a number")
    expect(readPaneWidth()).toBe(420)
  })

  test("storage that throws costs the pane its memory, not its render", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage is disabled in this partition")
      },
    })
    try {
      expect(readPaneWidth()).toBe(420)
      expect(() => writePaneWidth(500)).not.toThrow()
    } finally {
      Object.defineProperty(window, "localStorage", original)
    }
  })
})

describe("skill documents", () => {
  test("the pane renders the SKILL.md body without its frontmatter", () => {
    expect(skillBody("---\nname: docs\ndescription: Look things up\n---\n\n# Docs\n\nBody")).toBe("# Docs\n\nBody")
    expect(skillBody("# No frontmatter\n")).toBe("# No frontmatter\n")
  })

  test("a skill 404 shows the server message instead of the request error class", async () => {
    await renderDirectory({
      skill: {
        status: 404,
        body: { error: { code: "agent_plugins_skill_not_found", message: "No catalog or retained artifact serves this skill" } },
      },
    })
    const pane = await openPane("context7")
    await fireEvent.click(within(pane).getByRole("button", { name: /docs-lookup/ }))

    await waitFor(() => expect(within(pane).getByText("No catalog or retained artifact serves this skill")).toBeVisible())
    expect(within(pane).queryByText(/AgentPluginRequestError/)).toBeNull()
  })
})

describe("connection status failures", () => {
  test("a failed connections list leaves the Directory standing and offers a retry in the pane", async () => {
    const options: Parameters<typeof harness>[0] = { connectionsError: new Error("Connections request failed (500: could not renew the session)") }
    await renderDirectory(options)
    expect(screen.getByRole("button", { name: "composio" })).toBeTruthy()
    const pane = await openPane("composio")
    expect(within(pane).getByText(/Connection status is unavailable right now/)).toBeTruthy()
    expect(within(pane).getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(within(pane).queryByText(/could not renew the session/)).toBeNull()
    options.connectionsError = undefined
    fireEvent.click(within(pane).getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(within(pane).queryByText(/Connection status is unavailable right now/)).toBeNull())
    expect(within(pane).queryByRole("button", { name: "Retry" })).toBeNull()
  })
})

describe("Personal entries", () => {
  test("a Personal card opens a pane with the harness, marketplace, and location", async () => {
    await renderDirectory()
    const card = await screen.findByRole("button", { name: "figma" })
    await fireEvent.click(card)
    const pane = await screen.findByRole("complementary", { name: "figma details" })
    expect(within(pane).getByText("Cursor", { selector: "dd" })).toBeTruthy()
    expect(within(pane).getByText(/\.cursor\/plugins\/local/)).toBeTruthy()
    await fireEvent.click(within(pane).getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("complementary", { name: "figma details" })).toBeNull()
  })

  test("a skill the machine scan found is a Personal row alongside the plugins", async () => {
    await renderDirectory()
    const personal = within(await screen.findByRole("region", { name: "Personal" }))

    const pdf = personal.getByRole("button", { name: /pdf/ })
    expect(within(pdf).getByText("claude")).toBeVisible()
    expect(within(pdf).getByText("skill")).toBeVisible()
    expect(personal.getByRole("button", { name: /review/ })).toBeVisible()
    expect(personal.getByRole("button", { name: /figma/ })).toBeVisible()
  })

  test("a skill's pane reports where it lives and offers nothing that touches the disk", async () => {
    await renderDirectory()

    await fireEvent.click(await screen.findByRole("button", { name: /pdf/ }))
    const pane = await screen.findByRole("complementary", { name: "pdf details" })

    expect(within(pane).getByText("Claude Code", { selector: "dd" })).toBeVisible()
    expect(within(pane).getByText("skill", { selector: "dd" })).toBeVisible()
    expect(within(pane).getByText("~/.claude/skills/pdf")).toBeVisible()
    expect(within(pane).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Close"])
  })

  test("a harness with no plugin adapter still names its skills", async () => {
    await renderDirectory()

    await fireEvent.click(await screen.findByRole("button", { name: /review/ }))
    const pane = await screen.findByRole("complementary", { name: "review details" })

    expect(within(pane).getByText("AGENTS.md harnesses", { selector: "dd" })).toBeVisible()
  })
})

describe("unknown connection status", () => {
  test("an unreadable connection list never reads as needs-authentication", async () => {
    await renderDirectory({ connectionsError: new Error("plane unreachable") })
    expect(screen.queryByText("Needs authentication")).toBeNull()
    expect(screen.queryByRole("heading", { name: /Needs attention/ })).toBeNull()
  })
})

/**
 * The URL a fetch call targeted. `fetch` accepts a string, a `URL` or a
 * `Request`, and only the first two survive `String(...)` — a `Request` would
 * stringify to `[object Request]`.
 */
function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input)
}

/** The JSON a fetch call carried. A non-string body is not something we send. */
function requestJson(init?: RequestInit): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined
}
