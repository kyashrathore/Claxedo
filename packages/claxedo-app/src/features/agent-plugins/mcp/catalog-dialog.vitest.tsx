// The `/mcp` dialog against the real `agentPluginApi` over a fetch mock: only
// the network is substituted, so the recorded requests are proof that install
// and uninstall travel the Agent Plugins activation route rather than a copy.
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { JSX } from "solid-js"
import { agentPluginApi, type PluginCandidate, type PluginCatalog } from "@/features/agent-plugins/api"

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title?: JSX.Element; children?: JSX.Element }) => (
    <section aria-label={typeof props.title === "string" ? props.title : undefined}>{props.children}</section>
  ),
}))
vi.mock("@opencode-ai/ui/button", () => ({
  Button: (props: { disabled?: boolean; onClick?: () => void; children?: JSX.Element }) => (
    <button type="button" disabled={props.disabled} onClick={() => props.onClick?.()}>{props.children}</button>
  ),
}))
vi.mock("@opencode-ai/ui/toast", () => ({ showToast: vi.fn() }))
vi.mock("@/ui/controls/claxedo-icon", () => ({ ClaxedoIcon: () => <span /> }))

let confirmBody: (() => JSX.Element) | undefined
vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    push: (element: () => JSX.Element) => {
      confirmBody = element
    },
    show: () => {},
    close: () => {
      confirmBody = undefined
    },
  }),
}))

vi.mock("@/platform/i18n/provider", async () => {
  const { dict } = await import("@/platform/i18n/en")
  const strings = dict as Record<string, string>
  return {
    useLanguage: () => ({
      t: (key: string, params?: Record<string, string | number | boolean>) =>
        Object.entries(params ?? {}).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          strings[key] ?? key,
        ),
    }),
  }
})

const { McpCatalogDialog } = await import("./catalog-dialog")

const BASE = "https://control.example"

const READY = {
  explicit: null,
  projectOverride: null,
  userDefault: null,
  organizationDefault: false,
  claxedoDefault: false,
  effective: { status: "ready" as const, effective: false, winner: "none" },
}

const harnessesFor = (installed: boolean) => {
  const state = { ...READY, effective: { ...READY.effective, effective: installed } }
  return { opencode: state, claude: state, codex: state, cursor: state }
}

function candidate(input: {
  name: string
  installed?: boolean
  mcpServers?: PluginCandidate["mcpServers"]
}): PluginCandidate {
  return {
    pluginInstanceId: `["claxedo","${input.name}"]`,
    sourceId: "claxedo",
    sourceKind: "claxedo",
    source: { id: "claxedo", kind: "claxedo", label: "Claxedo" },
    icon: { kind: "monogram", text: "C" },
    skills: [],
    sourceRevision: "main",
    relativePath: `catalog/${input.name}`,
    candidateDigest: "sha256:candidate",
    sourceAvailable: true,
    retainedDigest: input.installed ? "sha256:retained" : null,
    updateAvailable: false,
    manifest: { name: input.name, version: "1.0.0", description: `${input.name} plugin` },
    componentDiagnostics: [],
    mcpServers: input.mcpServers ?? [],
    harnesses: harnessesFor(input.installed === true),
  }
}

const catalogBody = (): PluginCatalog => ({
  revision: 4,
  supportedHarnesses: ["opencode", "claude", "codex", "cursor"],
  projects: [{ id: "project-1", label: "Project One" }],
  canManageOrganizationDefaults: false,
  canManageOrganizationConnections: false,
  candidates: [
    candidate({
      name: "composio",
      installed: true,
      mcpServers: [{ name: "composio-remote", type: "streamable-http", authentication: { state: "oauth", integrationId: "mcp-composio" } }],
    }),
    candidate({
      name: "clangd",
      mcpServers: [{ name: "clangd-stdio", type: "stdio", authentication: { state: "local" } }],
    }),
    candidate({ name: "docs-skill" }),
  ],
  errors: [],
})

type Recorded = { path: string; method: string; body?: unknown }

async function renderDialog(options: { mode?: "signed" | "unsigned" } = {}) {
  const recorded: Recorded[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? "GET"
    recorded.push({
      path: url.pathname,
      method,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    })
    if (method === "POST") return Response.json({ revision: 5, reconciliation: { state: "applied" } })
    return Response.json(catalogBody())
  })
  const onInstall = vi.fn(async (_plugin: PluginCandidate, _catalog: PluginCatalog) => {})
  const onOpenDirectory = vi.fn()
  render(() => (
    <McpCatalogDialog
      mode={options.mode ?? "signed"}
      api={agentPluginApi({ baseUrl: BASE, request: fetchMock })}
      onInstall={onInstall}
      onOpenDirectory={onOpenDirectory}
    />
  ))
  await screen.findByTestId('mcp-entry-["claxedo","composio"]')
  return { recorded, onInstall, onOpenDirectory }
}

const row = (name: string) => within(screen.getByTestId(`mcp-entry-["claxedo","${name}"]`))

afterEach(() => {
  cleanup()
  confirmBody = undefined
})

describe("the /mcp dialog", () => {
  test("lists the catalog entries that serve an MCP server and no others", async () => {
    await renderDialog()

    expect(row("composio").getByText("composio-remote")).toBeTruthy()
    expect(row("clangd").getByText("clangd-stdio")).toBeTruthy()
    expect(screen.queryByTestId('mcp-entry-["claxedo","docs-skill"]')).toBeNull()
    expect(row("composio").getByText("Installed")).toBeTruthy()
    expect(row("clangd").queryByText("Installed")).toBeNull()
  })

  test("the search field narrows the list", async () => {
    await renderDialog()

    fireEvent.input(screen.getByLabelText("Search MCP servers"), { target: { value: "clangd" } })

    expect(screen.queryByTestId('mcp-entry-["claxedo","composio"]')).toBeNull()
    expect(screen.getByTestId('mcp-entry-["claxedo","clangd"]')).toBeTruthy()
  })

  test("Install hands the plugin and the catalog it was read from to the install sheet", async () => {
    const { onInstall, recorded } = await renderDialog()

    fireEvent.click(row("clangd").getByRole("button", { name: "Install" }))
    await vi.waitFor(() => expect(onInstall).toHaveBeenCalled())

    const [plugin, catalog] = onInstall.mock.calls[0]
    expect(plugin.pluginInstanceId).toBe('["claxedo","clangd"]')
    expect(catalog.revision).toBe(4)
    expect(recorded.every((call) => call.method === "GET")).toBe(true)
  })

  test("Uninstall posts the shared revision-guarded activation for the read revision", async () => {
    const { recorded } = await renderDialog()

    fireEvent.click(row("composio").getByRole("button", { name: "Uninstall" }))
    await vi.waitFor(() => expect(confirmBody).toBeDefined())
    render(() => confirmBody!())
    fireEvent.click(within(screen.getByRole("region", { name: "Remove composio?" })).getByRole("button", { name: "Uninstall" }))

    await vi.waitFor(() => expect(recorded.some((call) => call.method === "POST")).toBe(true))
    expect(recorded.find((call) => call.method === "POST")).toEqual({
      path: "/api/claxedo/plugins/activation",
      method: "POST",
      body: {
        pluginInstanceId: '["claxedo","composio"]',
        harnessIds: ["opencode", "claude", "codex", "cursor"],
        choice: false,
        expectedRevision: 4,
        target: { scope: "projects", projectIds: ["project-1"] },
      },
    })
  })

  test("an unsigned uninstall names no project target", async () => {
    const { recorded } = await renderDialog({ mode: "unsigned" })

    fireEvent.click(row("composio").getByRole("button", { name: "Uninstall" }))
    await vi.waitFor(() => expect(confirmBody).toBeDefined())
    render(() => confirmBody!())
    fireEvent.click(within(screen.getByRole("region", { name: "Remove composio?" })).getByRole("button", { name: "Uninstall" }))

    await vi.waitFor(() => expect(recorded.some((call) => call.method === "POST")).toBe(true))
    expect(recorded.find((call) => call.method === "POST")?.body).not.toHaveProperty("target")
  })

  test("an OAuth-backed entry sends connection management to the Directory", async () => {
    const { onOpenDirectory } = await renderDialog()

    expect(row("clangd").queryByRole("button", { name: "Manage connection" })).toBeNull()
    fireEvent.click(row("composio").getByRole("button", { name: "Manage connection" }))

    expect(onOpenDirectory).toHaveBeenCalledTimes(1)
  })
})
