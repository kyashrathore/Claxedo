import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  buildMcpInstallRequest,
  filterMcpCatalogEntries,
  installMcpDialogEntry,
  loadMcpDialogData,
  mcpExtensionUrl,
  mcpPrimaryAction,
  type CatalogEntry,
} from "./dialog-select-mcp-logic"

const calls: Array<{ method: string; url: string; body?: unknown; fetch: "unsigned" }> = []
let installedMachine = false
let installedProject = false

async function requestBody(request: Request) {
  const text = await request.clone().text()
  return text ? JSON.parse(text) as unknown : undefined
}

function catalogBody() {
  return {
    version: 1,
    categories: [
      { id: "featured", label: "Featured" },
      { id: "mcp-servers", label: "MCP Servers" },
      { id: "skills", label: "Skills" },
    ],
    entries: [
      {
        id: "mcp-filesystem",
        name: "Filesystem",
        description: "Read and write files.",
        source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
        kind: "mcp",
        categories: ["mcp-servers"],
        recommendedScope: "machine",
        recommendedTargets: ["opencode", "claude"],
      },
      {
        id: "mcp-postgres",
        name: "Postgres",
        description: "Query Postgres databases.",
        source: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
        kind: "mcp",
        categories: ["mcp-servers", "data-and-analytics"],
        recommendedScope: "project",
        recommendedTargets: ["opencode", "codex"],
      },
      {
        id: "package-mcp-helper",
        name: "Helper MCP Package",
        description: "Package entry in the MCP category.",
        source: "acme/helper-mcp",
        kind: "package",
        categories: ["mcp-servers"],
        recommendedScope: "machine",
        recommendedTargets: ["opencode"],
      },
      {
        id: "anthropic-skill-pdf",
        name: "PDF Skill",
        description: "Not an MCP server.",
        source: "https://github.com/anthropics/skills/tree/main/skills/pdf",
        kind: "skill",
        categories: ["skills"],
        recommendedScope: "machine",
        recommendedTargets: ["claude"],
      },
    ],
  }
}

function catalogEntries() {
  return catalogBody().entries as CatalogEntry[]
}

async function fakeFetch(input: string, init?: RequestInit) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  calls.push({
    method: request.method,
    url: request.url,
    fetch: "unsigned",
    body: await requestBody(request),
  })

  if (url.pathname === "/api/claxedo/agent-config/extensions/catalog") {
    return Response.json(catalogBody())
  }

  if (url.pathname === "/api/claxedo/agent-config/extensions" && request.method === "GET") {
    const scope = url.searchParams.get("scope")
    return Response.json({
      desired: {
        version: 1,
        installs:
          scope === "machine" && installedMachine
            ? [{ id: "mcp-filesystem", package_name: "filesystem" }]
            : scope === "project" && installedProject
              ? [{ id: "mcp-postgres", package_name: "postgres" }]
              : [],
      },
      materialized: { version: 1, packages: {} },
    })
  }

  if (url.pathname === "/api/claxedo/agent-config/extensions" && request.method === "POST") {
    const body = await requestBody(request) as { source?: string } | undefined
    if (body?.source?.includes("postgres")) installedProject = true
    if (body?.source?.includes("filesystem")) installedMachine = true
    return Response.json({ ok: true }, { status: 201 })
  }

  throw new Error(`unexpected request: ${request.method} ${request.url}`)
}

beforeEach(() => {
  calls.length = 0
  installedMachine = false
  installedProject = false
})

afterEach(() => {
  calls.length = 0
})

describe("DialogSelectMcp", () => {
  test("builds Agent Extensions URLs locally", async () => {
    expect(String(mcpExtensionUrl("http://127.0.0.1:3001", "/catalog"))).toBe(
      "http://127.0.0.1:3001/api/claxedo/agent-config/extensions/catalog",
    )
    expect(String(mcpExtensionUrl("http://127.0.0.1:3001", "scan"))).toBe(
      "http://127.0.0.1:3001/api/claxedo/agent-config/extensions/scan",
    )
    expect(String(mcpExtensionUrl("http://127.0.0.1:3001", "scan", {
      scope: "project",
      directory: "/repo/main",
    }))).toBe(
      "http://127.0.0.1:3001/api/claxedo/agent-config/extensions/scan?scope=project&directory=%2Frepo%2Fmain",
    )
    expect(String(mcpExtensionUrl("https://control.example", "/pkg/enable", {
      scope: "workspace",
      workspaceId: "ws_123",
    }))).toBe(
      "https://control.example/api/claxedo/agent-config/extensions/pkg/enable?scope=workspace&workspaceId=ws_123",
    )

    const logic = await Bun.file(new URL("./dialog-select-mcp-logic.ts", import.meta.url)).text()
    const dialog = await Bun.file(new URL("./dialog-select-mcp.tsx", import.meta.url)).text()

    expect(logic).not.toContain("RuntimeGateway")
    expect(dialog).not.toContain("RuntimeGateway")
  })

  test("catalog MCP entries are loaded from Agent Extensions and searchable", async () => {
    const data = await loadMcpDialogData(fakeFetch, "http://127.0.0.1:3001", "/repo/main")

    expect(data.entries.map((entry) => entry.name)).toEqual(["Filesystem", "Postgres", "Helper MCP Package"])
    expect(filterMcpCatalogEntries(data.entries, "postgres").map((entry) => entry.name)).toEqual(["Postgres"])
    expect(data.entries.some((entry) => entry.name === "PDF Skill")).toBe(false)
    expect(calls.map((call) => new URL(call.url).pathname)).toContain("/api/claxedo/agent-config/extensions/catalog")
    expect(calls.some((call) => new URL(call.url).searchParams.get("scope") === "machine")).toBe(true)
    expect(calls.some((call) => new URL(call.url).searchParams.get("scope") === "project")).toBe(true)
  })

  test("installed records become uninstall actions", async () => {
    installedMachine = true
    const data = await loadMcpDialogData(fakeFetch, "http://127.0.0.1:3001", "/repo/main")
    const filesystem = data.entries.find((entry) => entry.id === "mcp-filesystem")

    expect(filesystem).toBeDefined()
    expect(mcpPrimaryAction(filesystem!, data.installed, "/repo/main")).toEqual({
      label: "Uninstall",
      disabled: false,
      kind: "uninstall",
    })
  })

  test("installs machine MCPs through Agent Extensions routes", async () => {
    const filesystem = catalogEntries()[0]!

    await installMcpDialogEntry(fakeFetch, "http://127.0.0.1:3001", filesystem, "/repo/main")

    const install = calls.find((call) => call.method === "POST")
    expect(new URL(install!.url).pathname).toBe("/api/claxedo/agent-config/extensions")
    expect(new URL(install!.url).searchParams.get("scope")).toBe("machine")
    expect(install?.fetch).toBe("unsigned")
    expect(install?.body).toEqual({
      source: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
      scope: "machine",
      targets: ["opencode", "claude"],
    })
  })

  test("installs project MCPs with the active directory", async () => {
    const postgres = catalogEntries()[1]!

    await installMcpDialogEntry(fakeFetch, "http://127.0.0.1:3001", postgres, "/repo/main")

    const install = calls.find((call) => call.method === "POST")
    expect(new URL(install!.url).searchParams.get("scope")).toBe("project")
    expect(new URL(install!.url).searchParams.get("directory")).toBe("/repo/main")
    expect(install?.body).toEqual({
      source: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
      scope: "project",
      directory: "/repo/main",
      targets: ["opencode", "codex"],
    })
  })

  test("disables project installs when no directory scope exists", async () => {
    const postgres = catalogEntries()[1]!

    expect(buildMcpInstallRequest(postgres)).toEqual({ disabledReason: "Open a project to install" })
    expect(mcpPrimaryAction(postgres, [])).toEqual({
      label: "Open a project to install",
      disabled: true,
      kind: "install",
    })

    await installMcpDialogEntry(fakeFetch, "http://127.0.0.1:3001", postgres)
    expect(calls).toHaveLength(0)
  })
})
