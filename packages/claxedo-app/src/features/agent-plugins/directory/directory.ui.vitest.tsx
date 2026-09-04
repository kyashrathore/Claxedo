import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { agentPluginApi } from "../api"
import type { AgentPluginConnectionPort } from "../connections"
import { directoryApi } from "./data"

// The detail pane renders SKILL.md through the app's shared markdown boundary,
// which drags marked/shiki and its providers into a component test. The
// established pattern in this package is to substitute that one barrel.
vi.mock("@/ui/session-kit", () => ({ Markdown: (props: { text: string }) => <pre>{props.text}</pre> as JSX.Element }))

const BASE = "https://control.example"

const activation = (effective: boolean, organizationDefault = false) => ({
  explicit: null,
  projectOverride: null,
  userDefault: null,
  organizationDefault,
  claxedoDefault: false,
  effective: { status: "ready", effective, winner: "user-default", artifactDigest: "sha256:retained" },
})

const harnesses = (effective: boolean, organizationDefault = false) => ({
  opencode: activation(effective, organizationDefault),
  claude: activation(effective, organizationDefault),
  codex: activation(effective, organizationDefault),
  cursor: activation(effective, organizationDefault),
})

const CLAXEDO = { id: "claxedo", kind: "claxedo", label: "Claxedo", repository: "kyashrathore/plugins" }
const ACME = { id: "src-acme", kind: "personal", label: "acme/agent-plugins", repository: "acme/agent-plugins" }

function candidate(input: {
  name: string
  installed: boolean
  source: typeof CLAXEDO
  retained?: boolean
  updateAvailable?: boolean
  mcpServers?: unknown[]
  skills?: unknown[]
  description?: string
}) {
  return {
    pluginInstanceId: `["${input.source.id}","${input.name}"]`,
    sourceId: input.source.id,
    sourceKind: input.source.kind,
    source: input.source,
    icon: { kind: "monogram", text: input.name.slice(0, 2).toUpperCase() },
    skills: input.skills ?? [],
    sourceRevision: "main",
    relativePath: input.name,
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

const OAUTH = { name: "knowledge", type: "streamable-http", authentication: { state: "oauth", integrationId: "mcp-knowledge" } }
const PUBLIC = { name: "docs-http", type: "streamable-http", authentication: { state: "public" } }

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
    load: async () => ({ connections: options.connections ?? [] }),
    open,
    disconnect,
  }
  return { recorded, fetchMock, port, open, disconnect }
}

async function renderDirectory(options: Parameters<typeof harness>[0] & { mode?: "signed" | "unsigned" } = {}) {
  const context = harness(options)
  const onAdd = vi.fn(async () => {})
  const { AgentPluginDirectory } = await import("./directory")
  render(() => (
    <AgentPluginDirectory
      mode={options.mode ?? "signed"}
      api={agentPluginApi({ baseUrl: BASE, request: context.fetchMock })}
      directory={directoryApi({ baseUrl: BASE, request: context.fetchMock })}
      connections={context.port}
      onAdd={onAdd}
    />
  ))
  await screen.findByRole("button", { name: "composio" })
  return { ...context, onAdd }
}

async function openPane(name: string) {
  await fireEvent.click(screen.getByRole("button", { name }))
  return await screen.findByRole("complementary", { name: `${name} details` })
}

const posted = (recorded: Recorded[], path: string) => recorded.filter((entry) => entry.url === path && entry.method === "POST")

afterEach(cleanup)

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
    expect(within(personal).queryByText("~/.cursor/plugins/local/claxedo-context7")).toBeNull()
  })

  test("a connected OAuth server keeps an installed plugin out of Needs attention", async () => {
    await renderDirectory({
      connections: [{ id: "c1", integrationId: "mcp-knowledge", scope: "personal", status: "connected" }],
    })

    await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull())
    const installed = screen.getByRole("region", { name: "Installed" })
    expect(within(installed).getByRole("button", { name: "composio" })).toBeVisible()
    expect(within(installed).getByText("Installed on 4 harnesses")).toBeVisible()
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
    expect(within(pane).getByText("Where it is installed")).toBeVisible()

    await fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "context7 details" })).toBeNull())
  })

  test("expanding a skill reads its SKILL.md from the retained artifact", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: /docs-lookup/ }))

    await waitFor(() => expect(recorded.some((entry) =>
      entry.url === `/api/claxedo/plugins/${encodeURIComponent('["claxedo","context7"]')}/skills/docs-lookup`)).toBe(true))
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

  test("Use default posts activation with choice null", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: "Use default" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/activation")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/activation")[0]!.body).toMatchObject({ choice: null })
  })

  test("Update posts the user authority when signed", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: "Update" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/update")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/update")[0]!.body).toEqual({
      pluginInstanceId: '["claxedo","context7"]',
      expectedRevision: 4,
      authority: "user",
    })
  })

  test("Enable for organization posts the positive organization default", async () => {
    const { recorded } = await renderDirectory()
    const pane = await openPane("context7")

    await fireEvent.click(within(pane).getByRole("button", { name: "Enable for organization" }))

    await waitFor(() => expect(posted(recorded, "/api/claxedo/plugins/organization-default")).toHaveLength(1))
    expect(posted(recorded, "/api/claxedo/plugins/organization-default")[0]!.body).toEqual({
      pluginInstanceId: '["claxedo","context7"]',
      harnessIds: ["opencode", "claude", "codex", "cursor"],
      choice: true,
      expectedRevision: 4,
    })
  })

  test("Connect opens the personal scope and Connect for organization the team scope", async () => {
    const { open } = await renderDirectory()
    const pane = await openPane("composio")

    await fireEvent.click(within(pane).getByRole("button", { name: "Connect" }))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: "mcp-knowledge",
      name: "knowledge MCP",
      scope: "personal",
      teamScopeEnabled: true,
    }))

    await fireEvent.click(within(pane).getByRole("button", { name: "Connect for organization" }))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ integrationId: "mcp-knowledge", scope: "team" }))
  })

  test("Disconnect calls the connection port with the connection id", async () => {
    const { disconnect } = await renderDirectory({
      connections: [{ id: "conn-1", integrationId: "mcp-knowledge", scope: "personal", status: "connected" }],
    })
    const pane = await openPane("composio")

    await fireEvent.click(await within(pane).findByRole("button", { name: "Disconnect" }))

    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("conn-1"))
  })
})

describe("Agent Plugin Directory unsigned mode", () => {
  test("hides the project scope and every organization action", async () => {
    await renderDirectory({ mode: "unsigned" })

    expect(screen.queryByLabelText("Inspect effective state for")).toBeNull()

    await fireEvent.click(screen.getByRole("button", { name: "context7" }))
    const pane = await screen.findByRole("complementary", { name: "context7 details" })
    expect(within(pane).queryByRole("button", { name: "Enable for organization" })).toBeNull()
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
