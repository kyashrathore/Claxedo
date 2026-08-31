import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { AgentPluginConnectionPort } from "./catalog"
import { agentPluginApi } from "./api"

let organizationManager = false
let issuers: string[] | undefined

const activation = {
  projectOverride: null,
  userDefault: null,
  organizationDefault: false,
  claxedoDefault: false,
  effective: { status: "ready", effective: true, winner: "user-default", artifactDigest: "sha256:retained" },
}

const catalog = () => ({
  revision: 4,
  supportedHarnesses: ["opencode", "claude", "codex", "cursor"],
  projects: [{ id: "project-1", label: "Project One" }],
  selectedProjectId: null,
  canManageOrganizationDefaults: organizationManager,
  canManageOrganizationConnections: organizationManager,
  candidates: [{
    pluginInstanceId: "[\"claxedo\",\"docs\"]",
    sourceId: "claxedo",
    sourceKind: "claxedo",
    sourceLabel: "Claxedo",
    sourceRevision: "main",
    relativePath: "docs",
    candidateDigest: "sha256:candidate",
    sourceAvailable: true,
    retainedDigest: "sha256:retained",
    updateAvailable: false,
    manifest: { name: "docs", version: "1.0.0" },
    componentDiagnostics: [],
    mcpServers: [{
      name: "knowledge",
      type: "streamable-http",
      authentication: { state: "oauth", integrationId: "mcp-knowledge", ...(issuers ? { issuers } : {}) },
    }],
    harnesses: { opencode: activation, claude: activation, codex: activation, cursor: activation },
  }],
  errors: [],
})

const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  if (url.pathname === "/api/claxedo/plugins") return Response.json(catalog())
  throw new Error(`unexpected request ${url}`)
})

vi.mock("@/platform/runtime/platform-provider", () => ({ usePlatform: () => ({ fetch: fakeFetch }) }))
vi.mock("@/platform/api/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/platform/api/api")>(),
  authFetch: fakeFetch,
  getClaxedoServerUrl: () => "https://control.example",
}))

afterEach(() => {
  cleanup()
  fakeFetch.mockClear()
  organizationManager = false
  issuers = undefined
})

async function renderCatalog(input: { connections?: Array<{ id: string; integrationId: string; scope: "personal" | "team"; status: "connected" }> } = {}) {
  const open = vi.fn<AgentPluginConnectionPort["open"]>()
  const disconnect = vi.fn<AgentPluginConnectionPort["disconnect"]>(async () => {})
  const port: AgentPluginConnectionPort = {
    load: async () => ({ connections: input.connections ?? [] }),
    open,
    disconnect,
  }
  const { AgentPluginCatalog } = await import("./catalog")
  render(() => <AgentPluginCatalog
    mode="signed"
    api={agentPluginApi({ baseUrl: "https://control.example", request: fakeFetch })}
    connections={port}
  />)
  await screen.findByText("knowledge")
  return { open, disconnect }
}

describe("Agent Plugin catalog MCP and organization controls", () => {
  test("a member gets a personal Connect action and no organization mutations", async () => {
    const { open } = await renderCatalog()

    expect(screen.queryByRole("button", { name: "Enable for organization" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Connect for organization" })).toBeNull()
    await fireEvent.click(screen.getByRole("button", { name: "Connect" }))

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: "mcp-knowledge",
      scope: "personal",
      teamScopeEnabled: false,
    }))
  })

  test("an organization admin sees the positive default and shared-connection controls", async () => {
    organizationManager = true
    await renderCatalog({ connections: [{ id: "org-connection", integrationId: "mcp-knowledge", scope: "team", status: "connected" }] })

    expect(screen.getByRole("button", { name: "Enable for organization" })).toBeVisible()
    expect(screen.getByText("Organization connection: connected")).toBeVisible()
    expect(screen.getByRole("button", { name: "Reconnect organization" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Disconnect organization" })).toBeVisible()
    await waitFor(() => expect(fakeFetch).toHaveBeenCalled())
  })

  test("requires an explicit authorization-server choice and passes it to Connect", async () => {
    issuers = ["https://one.example", "https://two.example"]
    const { open } = await renderCatalog()
    const connect = screen.getByRole("button", { name: "Connect" })
    expect(connect).toBeDisabled()

    await fireEvent.change(screen.getByLabelText("knowledge authorization server"), {
      target: { value: "https://two.example" },
    })
    expect(connect).not.toBeDisabled()
    await fireEvent.click(connect)

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: "mcp-knowledge",
      issuer: "https://two.example",
      scope: "personal",
    }))
  })
})
