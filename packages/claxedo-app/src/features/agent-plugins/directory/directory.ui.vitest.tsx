import { activationSummary, defaultOutcome, pluginStatus, skillBody } from "./view"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { JSX } from "solid-js"
import { agentPluginApi, type HarnessActivation, type PluginCandidate, type PluginSkill, type PluginSource } from "../api"
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
}): PluginCandidate {
  return {
    pluginInstanceId: `["${input.source.id}","${input.name}"]`,
    sourceId: input.source.id,
    sourceKind: input.source.kind,
    source: input.source,
    icon: { kind: "monogram", text: input.name.slice(0, 2).toUpperCase() },
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

function catalogBody(overrides: Record<string, unknown> = {}) {
  return {
    revision: 4,
    supportedHarnesses: ["opencode", "claude", "codex", "cursor"],
    projects: [{ id: "project-1", label: "Project One" }],
    selectedProjectId: null,
    canManageOrganizationDefaults: true,
    canManageOrganizationConnections: true,
    candidates: [
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
    ],
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
}

type Recorded = { url: string; method: string; body?: unknown }

function harness(options: {
  connectionsError?: Error
  catalog?: Record<string, unknown>
  sourceAdd?: { status: number; body: unknown }
  connections?: Array<{ id: string; integrationId: string; scope: "personal" | "team"; status: "connected" | "degraded" | "broken" }>
} = {}) {
  const recorded: Recorded[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
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
      return Response.json({ name: "docs-lookup", description: "Resolve a library id.", markdown: "# Steps\nresolve-library-id" })
    }
    if (method === "POST") return Response.json({ revision: 5, reconciliation: { state: "applied" } })
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

async function renderDirectory(options: Parameters<typeof harness>[0] & { mode?: "signed" | "unsigned" } = {}) {
  const context = harness(options)
  const onAdd = vi.fn(async () => {})
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { AgentPluginDirectory } = await import("./directory")
  render(() => (
    <QueryClientProvider client={client}>
      <AgentPluginDirectory
        mode={options.mode ?? "signed"}
        api={agentPluginApi({ baseUrl: BASE, request: context.fetchMock })}
        directory={directoryApi({ baseUrl: BASE, request: context.fetchMock })}
        connections={context.port}
        onAdd={onAdd}
      />
    </QueryClientProvider>
  ))
  await screen.findByRole("button", { name: "composio" })
  return { ...context, onAdd, client }
}

async function openPane(name: string) {
  await fireEvent.click(screen.getByRole("button", { name }))
  return await screen.findByRole("complementary", { name: `${name} details` })
}

const posted = (recorded: Recorded[], path: string) => recorded.filter((entry) => entry.url === path && entry.method === "POST")

afterEach(() => {
  cleanup()
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
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0]!.body).toEqual({
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

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0]!.body).toMatchObject({
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
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0]!.body).toMatchObject({ choice: null })
  })

  test("Update posts the user authority when signed", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("menuitem", { name: "Update to 1.0.0" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/update")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/update")[0]!.body).toEqual({
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
    expect(posted(recorded, "/api/claxedo/plugins/organization-default")[0]!.body).toEqual({
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

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("conn-1"))
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

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0]!.body).toEqual({
      pluginInstanceId: '["claxedo","context7"]',
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: false,
      expectedRevision: 4,
    })
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
})

describe("connection status failures", () => {
  test("a failed connections list leaves the Directory standing and offers a retry in the pane", async () => {
    await renderDirectory({ connectionsError: new Error("Connections request failed (500: could not renew the session)") })
    expect(screen.getByRole("button", { name: "composio" })).toBeTruthy()
    const pane = await openPane("composio")
    expect(within(pane).getByText(/Connection status is unavailable right now/)).toBeTruthy()
    expect(within(pane).getByRole("button", { name: "Retry" })).toBeTruthy()
    expect(within(pane).queryByText(/could not renew the session/)).toBeNull()
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
})
