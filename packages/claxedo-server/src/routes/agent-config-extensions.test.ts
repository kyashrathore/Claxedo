import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { localOnlyAuthAdapter, type ClerkVerifier } from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import { createAgentConfigRoutes } from "./agent-config"
import { AgentExtensionConflictError, installCachedAgentExtension } from "../agent-extensions/install"
import {
  mirrorWorkspaceAgentExtensionRecord,
  readMirroredWorkspaceAgentExtensions,
} from "../agent-extensions/workspace"
import { AgentExtensionMaterializationError } from "@claxedo/agent-extensions"

const root = `${process.env.TMPDIR ?? "/tmp"}/agent-config-extensions-route-${Date.now()}-${Math.random().toString(16).slice(2)}`
const home = `${root}/home`
const data = `${home}/.claxedo`
const project = `${root}/project`
const source = `${root}/source`
const packages = `${root}/packages`
const prev = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
}

process.env.HOME = home
process.env.CLAXEDO_DATA_DIR = data

async function writeSource(file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true })
  await fs.writeFile(path.join(source, file), content)
}

async function writePackage(name: string, file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(packages, name, file)), { recursive: true })
  await fs.writeFile(path.join(packages, name, file), content)
}

async function expectMaterializedDirectory(target: string) {
  const stat = await fs.lstat(target)
  expect(stat.isDirectory() || stat.isSymbolicLink()).toBe(true)
}

function route() {
  return createAgentConfigRoutes({ homeDir: home })
}

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed",
  token,
  user: {
    subject: token,
    tokenIdentifier: `${config.issuer}|${token}`,
    issuer: config.issuer,
  },
})

function services(authority: NonNullable<ControlPlaneServices["authority"]>): ControlPlaneServices {
  return {
    projectionStore: {} as never,
    durableSessionLog: {} as never,
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: true },
    authority,
  }
}

// The catalog source of `anthropic-skill-pdf` exactly as parsePackageSource
// yields it. A record persisted before installs were pinned to the catalog id
// sits under the fetched package's own name (`pdf`) with this same source —
// that is the key the workspace routes resolve and absorb it by.
const pdfCatalogSource = {
  type: "github" as const,
  owner: "anthropics",
  repo: "skills",
  ref: "main",
  package_path: "skills/pdf",
}

function legacyPdfRecord() {
  return {
    desired: {
      id: "pdf",
      package_name: "pdf",
      source: pdfCatalogSource,
      scope: "workspace" as const,
      enabled: false,
      targets: ["claude" as const],
      installed_at: 5,
      updated_at: 5,
    },
    lock: {
      source: pdfCatalogSource,
      resolved_sha: "abcdef1234567890",
      manifest_digests: { package: "abc" },
      component_digests: { package: "abc" },
      targets: ["claude" as const],
    },
  }
}

function resolvedPinnedPdf(id = "anthropic-skill-pdf", targets: Array<"claude"> = ["claude"]) {
  return {
    id,
    package: { type: "standalone-skill", name: "pdf", skill_path: "SKILL.md" } as const,
    cache: { path: "/cache/pdf", checksum: "def", resolvedSha: "fedcba9876543210" },
    record: {
      desired: {
        id,
        package_name: "pdf",
        source: pdfCatalogSource,
        scope: "workspace" as const,
        enabled: true,
        targets,
        installed_at: 200,
        updated_at: 200,
      },
      lock: {
        source: pdfCatalogSource,
        resolved_sha: "fedcba9876543210",
        manifest_digests: { package: "def" },
        component_digests: { package: "def" },
        targets,
      },
    },
  }
}

describe("Agent Config Agent Extensions routes", () => {
  beforeAll(async () => {
    await fs.mkdir(home, { recursive: true })
  })

  beforeEach(async () => {
    await fs.rm(source, { recursive: true, force: true })
    await fs.rm(packages, { recursive: true, force: true })
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(data, { recursive: true, force: true })
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(packages, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(data, { recursive: true })
  })

  afterAll(async () => {
    process.env.HOME = prev.HOME
    process.env.CLAXEDO_DATA_DIR = prev.CLAXEDO_DATA_DIR
    await fs.rm(root, { recursive: true, force: true })
  })

  test("scan discovers existing config candidates without modifying them", async () => {
    await fs.mkdir(path.join(project, ".cursor"), { recursive: true })
    await fs.writeFile(path.join(project, "AGENTS.md"), "# agents\n")

    const res = await route().request(`/extensions/scan?directory=${encodeURIComponent(project)}`)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual([
      { path: ".cursor", kind: "harness-config-dir", state: "discovered" },
      { path: "AGENTS.md", kind: "instruction-file", state: "discovered" },
    ])
    await expect(fs.readFile(path.join(project, "AGENTS.md"), "utf8")).resolves.toBe("# agents\n")
  })

  test("scan adoption, ignore, and detach preserve unmanaged files", async () => {
    await fs.mkdir(path.join(project, ".cursor"), { recursive: true })
    await fs.writeFile(path.join(project, "AGENTS.md"), "# agents\n")

    const adopt = await route().request("/extensions/adopt", {
      method: "POST",
      body: JSON.stringify({ directory: project, path: "AGENTS.md" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(adopt.status).toBe(200)
    await expect(adopt.json()).resolves.toEqual({
      path: "AGENTS.md",
      kind: "instruction-file",
      state: "adopted",
    })

    const ignore = await route().request("/extensions/ignore", {
      method: "POST",
      body: JSON.stringify({ directory: project, path: ".cursor" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(ignore.status).toBe(200)
    await expect(ignore.json()).resolves.toEqual({
      path: ".cursor",
      kind: "harness-config-dir",
      state: "ignored",
    })

    const scan = await route().request(`/extensions/scan?directory=${encodeURIComponent(project)}`)
    expect(scan.status).toBe(200)
    await expect(scan.json()).resolves.toEqual([
      { path: ".cursor", kind: "harness-config-dir", state: "ignored" },
      { path: "AGENTS.md", kind: "instruction-file", state: "adopted" },
    ])
    await expect(fs.readFile(path.join(project, "AGENTS.md"), "utf8")).resolves.toBe("# agents\n")

    const detach = await route().request("/extensions/detach", {
      method: "POST",
      body: JSON.stringify({ directory: project, path: "AGENTS.md" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(detach.status).toBe(200)
    await expect(detach.json()).resolves.toEqual({
      path: "AGENTS.md",
      kind: "instruction-file",
      state: "discovered",
    })
  })

  test("lists, disables, enables, and uninstalls owned project extensions", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const installed = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    const target = path.join(project, ".cursor", "skills", path.basename(installed.cache.path))

    const list = await route().request(`/extensions?directory=${encodeURIComponent(project)}`)
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      desired: { installs: [{ id: "review", enabled: true }] },
      materialized: { packages: { review: { status: "applied" } } },
    })

    const disable = await route().request(`/extensions/review/disable?directory=${encodeURIComponent(project)}`, { method: "POST" })
    expect(disable.status).toBe(200)
    await expect(disable.json()).resolves.toMatchObject({ id: "review", materialized: { enabled: false, status: "disabled" } })
    await expect(fs.stat(target)).rejects.toThrow()

    const disabledList = await route().request(`/extensions?directory=${encodeURIComponent(project)}`)
    expect(disabledList.status).toBe(200)
    await expect(disabledList.json()).resolves.toMatchObject({
      desired: { installs: [{ id: "review", enabled: false }] },
      effective: {
        review: {
          enabled: false,
          source: "desired",
          reason: "desired install is disabled",
        },
      },
    })

    const enable = await route().request(`/extensions/review/enable?directory=${encodeURIComponent(project)}`, { method: "POST" })
    expect(enable.status).toBe(200)
    await expect(enable.json()).resolves.toMatchObject({ id: "review", materialized: { enabled: true, status: "applied" } })
    await expectMaterializedDirectory(target)
    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toContain("name: review")

    const remove = await route().request(`/extensions/review?directory=${encodeURIComponent(project)}`, { method: "DELETE" })
    expect(remove.status).toBe(200)
    await expect(remove.json()).resolves.toEqual({ ok: true })
    await expect(fs.stat(target)).rejects.toThrow()
  })

  test("lists, disables, enables, and uninstalls owned machine extensions", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const installed = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "machine",
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    const target = path.join(home, ".cursor", "skills", path.basename(installed.cache.path))

    const list = await route().request("/extensions?scope=machine")
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      desired: { installs: [{ id: "review", scope: "machine", enabled: true }] },
      materialized: { packages: { review: { status: "applied" } } },
    })

    const disable = await route().request("/extensions/review/disable?scope=machine", { method: "POST" })
    expect(disable.status).toBe(200)
    await expect(disable.json()).resolves.toMatchObject({ id: "review", materialized: { enabled: false, status: "disabled" } })
    await expect(fs.stat(target)).rejects.toThrow()

    const enable = await route().request("/extensions/review/enable?scope=machine", { method: "POST" })
    expect(enable.status).toBe(200)
    await expect(enable.json()).resolves.toMatchObject({ id: "review", materialized: { enabled: true, status: "applied" } })
    await expectMaterializedDirectory(target)
    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toContain("name: review")

    const remove = await route().request("/extensions/review?scope=machine", { method: "DELETE" })
    expect(remove.status).toBe(200)
    await expect(remove.json()).resolves.toEqual({ ok: true })
    await expect(fs.stat(target)).rejects.toThrow()
  })

  test("requires directory for project extension state", async () => {
    const res = await route().request("/extensions")

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "agent_extension_project_directory_required",
        message: "directory is required for project Agent Extensions",
      },
    })
  })

  test("install route validates source, scope, and targets before fetch", async () => {
    const missing = await route().request(`/extensions?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    })
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "agent_extension_source_required",
        message: "source is required",
      },
    })

    const noDirectory = await route().request("/extensions", {
      method: "POST",
      body: JSON.stringify({ source: "acme/tools" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(noDirectory.status).toBe(400)
    await expect(noDirectory.json()).resolves.toEqual({
      error: {
        code: "agent_extension_project_directory_required",
        message: "directory is required for project Agent Extensions",
      },
    })

    const badTargets = await route().request(`/extensions?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify({ source: "acme/tools", targets: ["cursor", "vim"] }),
      headers: { "Content-Type": "application/json" },
    })
    expect(badTargets.status).toBe(400)
    await expect(badTargets.json()).resolves.toEqual({
      error: {
        code: "agent_extension_targets_invalid",
        message: "targets must contain only opencode, claude, codex, or cursor",
      },
    })

    const badSource = await route().request(`/extensions?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify({ source: "https://example.com/acme/tools" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(badSource.status).toBe(400)
    await expect(badSource.json()).resolves.toEqual({
      error: {
        code: "agent_extension_install_failed",
        message: "Only https://github.com sources are supported",
      },
    })
  })

  test("install route passes GitHub source input to the install service", async () => {
    const calls: unknown[] = []
    const app = createAgentConfigRoutes({
      homeDir: home,
      installGitHubAgentExtension: async (input) => {
        calls.push(input)
        return {
          id: input.id ?? "review",
          package: { type: "standalone-skill", name: "review", skill_path: "SKILL.md" },
          cache: { path: "/cache/review", checksum: "abc" },
          materialized: {
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            resolved_sha: "abcdef1234567890",
            enabled: true,
            targets: input.targets ?? ["cursor"],
            components: [],
            materialized_at: 100,
            status: "applied",
          },
        }
      },
      updateAgentExtension: async (input) => ({
        id: input.id,
        package: { type: "standalone-skill", name: "review", skill_path: "SKILL.md" },
        cache: { path: "/cache/review", checksum: "def" },
        materialized: {
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "fedcba9876543210",
          enabled: true,
          targets: ["cursor"],
          components: [],
          materialized_at: 200,
          status: "applied",
        },
      }),
    })

    const res = await app.request(`/extensions?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify({ source: "acme/review", id: "review", targets: ["opencode", "cursor"] }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toMatchObject({
      id: "review",
      materialized: { status: "applied" },
    })
    expect(calls).toEqual([{
      source: "acme/review",
      scope: "project",
      projectDir: project,
      homeDir: home,
      id: "review",
      targets: ["opencode", "cursor"],
    }])

    const update = await app.request(`/extensions/review/update?directory=${encodeURIComponent(project)}`, { method: "POST" })
    expect(update.status).toBe(200)
    await expect(update.json()).resolves.toMatchObject({
      materialized: {
        resolved_sha: "fedcba9876543210",
        status: "applied",
      },
    })
  })

  test("install route returns structured conflict errors", async () => {
    const app = createAgentConfigRoutes({
      homeDir: home,
      installGitHubAgentExtension: async () => {
        throw new AgentExtensionConflictError(
          "agent_extension_source_conflict",
          "Agent Extension review is already installed from a different source",
          {
            id: "review",
            existingSource: { type: "github", owner: "acme", repo: "review" },
            requestedSource: { type: "github", owner: "other", repo: "review" },
          },
        )
      },
    })

    const res = await app.request(`/extensions?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify({ source: "other/review", id: "review", targets: ["cursor"] }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "agent_extension_source_conflict",
        message: "Agent Extension review is already installed from a different source",
        details: {
          id: "review",
          existingSource: { type: "github", owner: "acme", repo: "review" },
          requestedSource: { type: "github", owner: "other", repo: "review" },
        },
      },
    })
  })

  test("install route returns structured materialization conflict errors", async () => {
    const app = createAgentConfigRoutes({
      homeDir: home,
      installGitHubAgentExtension: async () => {
        throw new AgentExtensionMaterializationError(
          "MCP server docs already exists in /tmp/project/.cursor/mcp.json",
          "agent_extension_mcp_server_conflict",
          {
            ownerId: "docs",
            runner: "cursor",
            serverName: "docs",
            targetPath: "/tmp/project/.cursor/mcp.json",
          },
        )
      },
    })

    const res = await app.request(`/extensions?directory=${encodeURIComponent(project)}`, {
      method: "POST",
      body: JSON.stringify({ source: "acme/docs", id: "docs", targets: ["cursor"] }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "agent_extension_mcp_server_conflict",
        message: "MCP server docs already exists in /tmp/project/.cursor/mcp.json",
        details: {
          ownerId: "docs",
          runner: "cursor",
          serverName: "docs",
          targetPath: "/tmp/project/.cursor/mcp.json",
        },
      },
    })
  })

  test("install route materializes real skill, plugin, and MCP packages through Agent Extensions", async () => {
    await writePackage("review-skill", "SKILL.md", "---\nname: review-skill\n---\n")
    await writePackage("cursor-tools", ".cursor-plugin/plugin.json", JSON.stringify({ name: "cursor-tools" }))
    await writePackage("docs-mcp", "mcp.json", JSON.stringify({ servers: { docs: { command: "node", args: ["server.js"] } } }))
    const shas: Record<string, string> = {
      "review-skill": "abcdef1000000000",
      "cursor-tools": "abcdef2000000000",
      "docs-mcp": "abcdef3000000000",
    }

    const app = createAgentConfigRoutes({
      homeDir: home,
      installGitHubAgentExtension: async (input) => installCachedAgentExtension({
        sourceRoot: path.join(packages, input.id ?? path.basename(input.source)),
        source: { type: "github", owner: "local", repo: input.id ?? path.basename(input.source) },
        resolvedSha: shas[input.id ?? path.basename(input.source)]!,
        scope: input.scope,
        ...(input.projectDir ? { projectDir: input.projectDir } : {}),
        homeDir: input.homeDir,
        ...(input.targets ? { targets: input.targets } : {}),
        ...(input.id ? { id: input.id } : {}),
        now: 100,
      }),
    })

    for (const item of [
      { source: "local/review-skill", id: "review-skill", targets: ["cursor"] },
      { source: "local/cursor-tools", id: "cursor-tools", targets: ["cursor"] },
      { source: "local/docs-mcp", id: "docs-mcp", targets: ["cursor", "codex"] },
    ] as const) {
      const res = await app.request(`/extensions?directory=${encodeURIComponent(project)}`, {
        method: "POST",
        body: JSON.stringify(item),
        headers: { "Content-Type": "application/json" },
      })
      if (res.status !== 201) throw new Error(await res.text())
      expect(res.status).toBe(201)
      await expect(res.json()).resolves.toMatchObject({
        id: item.id,
        materialized: { enabled: true },
      })
    }

    await expectMaterializedDirectory(path.join(project, ".cursor", "skills", shas["review-skill"]))
    await expect(fs.readFile(path.join(project, ".cursor", "skills", shas["review-skill"], "SKILL.md"), "utf8")).resolves.toContain("review-skill")
    await expectMaterializedDirectory(path.join(home, ".cursor", "plugins", "local", "cursor-tools"))
    await expect(fs.readFile(path.join(home, ".cursor", "plugins", "local", "cursor-tools", ".cursor-plugin", "plugin.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ name: "cursor-tools" })
    await expect(fs.readFile(path.join(project, ".cursor", "mcp.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      mcpServers: {
        docs: { command: "node", args: ["server.js"] },
      },
    })
    await expect(fs.readFile(path.join(project, ".codex", "config.toml"), "utf8")).resolves.toContain("[mcp_servers.docs]")

    const list = await app.request(`/extensions?directory=${encodeURIComponent(project)}`)
    expect(list.status).toBe(200)
    const listed = await list.json() as {
      desired: { installs: Array<{ id: string; enabled: boolean; targets: string[] }> }
      materialized: { packages: Record<string, { status: string }> }
    }
    expect(Object.fromEntries(listed.desired.installs.map((item) => [item.id, {
      enabled: item.enabled,
      targets: [...item.targets].sort(),
    }]))).toMatchObject({
      "review-skill": { enabled: true, targets: ["cursor"] },
      "cursor-tools": { enabled: true, targets: ["cursor"] },
      "docs-mcp": { enabled: true, targets: ["codex", "cursor"] },
    })
    expect(listed.materialized.packages).toMatchObject({
      "review-skill": { status: "applied" },
      "cursor-tools": { status: "applied" },
      "docs-mcp": { status: "applied" },
    })
  })

  test("workspace scope stores desired installs through the Control Plane boundary without depending on telemetry", async () => {
    const convex = {
      usersMe: async () => ({}),
      listOrgs: async () => [],
      resolveOrgId: async () => "org_1" as never,
      authorizeSessionRead: async () => {},
      authorizeWorkspaceOpen: async () => {},
      projectRole: async () => ({ ok: false as const }),
      authorizeProject: async () => ({ ok: false as const }),
      authorizeChannelProject: async () => ({ ok: false as const }),
      authorizeChannelWorkspace: async () => {},
      openWorkspace: async () => ({ allowed: true }),
      listWorkspaces: async () => [],
      registerLocalForSharing: async () => ({}),
      createLocalHostLinkChallenge: async () => ({ challenge_id: "challenge_1", nonce: "nonce_1", expires_at: 1 }),
      registerLocalHostLink: async () => ({}),
      heartbeatLocalHostLink: async () => ({}),
      pauseLocalHostLink: async () => ({}),
      activeLocalHostLink: async () => ({ active: false as const }),
      deleteWorkspace: async () => ({}),
      createCloudWorkspace: async () => ({}),
      grantWorkspaceShare: async () => ({}),
      revokeWorkspaceShare: async () => ({}),
      listSessions: async () => [],
      readSessionMessages: async () => ({ allowed: true, messages: [] }),
      syncSessionMessages: async () => ({}),
      upsertSessionVisibility: async () => ({}),
      replaceSessionVisibility: async () => ({}),
      deleteSessionVisibility: async () => ({}),
      recordRuntimeAccessToken: async () => ({}),
      recordRuntimeAccessTokenForService: async () => ({}),
      runtimeAccessTokenActive: async () => ({ active: true }),
      revokeRuntimeAccessToken: async () => ({}),
      revokeRuntimeAccessTokensForWorkspaceUser: async () => ({}),
      listWorkspaceAgentExtensions: vi.fn(async () => [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 1,
          updated_at: 1,
        },
        lock: { resolved_sha: "abcdef1234567890" },
      }]),
      listWorkspaceAgentExtensionsForRuntime: vi.fn(async () => []),
      authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {}),
      upsertWorkspaceAgentExtension: vi.fn(async () => ({})),
      setWorkspaceAgentExtensionEnabled: vi.fn(async () => ({})),
      deleteWorkspaceAgentExtension: vi.fn(async () => ({})),
      listAgentExtensionPolicyOverrides: vi.fn(async () => []),
      listAgentExtensionPolicyOverridesForRuntime: vi.fn(async () => []),
      setAgentExtensionPolicyOverride: vi.fn(async () => ({})),
      deleteAgentExtensionPolicyOverride: vi.fn(async () => ({})),
      auditDeny: async () => {},
      auditAllow: async () => {},
    } satisfies NonNullable<ControlPlaneServices["authority"]>
    const svc = services(convex)
    svc.telemetry = {
      capture: vi.fn(() => {
        throw new Error("telemetry down")
      }),
    }
    const app = createAgentConfigRoutes({
      services: svc,
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension: async () => ({
        id: "review",
        package: { type: "standalone-skill", name: "review", skill_path: "SKILL.md" },
        cache: { path: "/cache/review", checksum: "abc", resolvedSha: "abcdef1234567890" },
        record: {
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            scope: "workspace",
            enabled: true,
            targets: ["cursor"],
            installed_at: 100,
            updated_at: 100,
          },
          lock: {
            source: { type: "github", owner: "acme", repo: "review" },
            resolved_sha: "abcdef1234567890",
            manifest_digests: { package: "abc" },
            component_digests: { package: "abc" },
            targets: ["cursor"],
          },
        },
      }),
    })

    const install = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      body: JSON.stringify({ source: "acme/review", targets: ["cursor"] }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_1",
      },
    })
    expect(install.status).toBe(201)
    await expect(install.json()).resolves.toMatchObject({
      desired: { id: "review", scope: "workspace", enabled: true },
      lock: { resolved_sha: "abcdef1234567890" },
    })
    expect(convex.upsertWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "review",
      packageName: "review",
      desired: expect.objectContaining({ id: "review", scope: "workspace" }),
      lock: expect.objectContaining({ resolved_sha: "abcdef1234567890" }),
    })
    expect(convex.authorizeWorkspaceAgentExtensionsAdmin).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
    })
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "agent_extension.install", {
      id: "review",
      scope: "workspace",
      workspaceId: "ws_1",
      source: "acme/review",
      targets: ["cursor"],
    })

    const list = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      desired: { installs: [{ id: "review", scope: "workspace" }] },
      materialized: { packages: {} },
    })

    const disable = await app.request("/extensions/review/disable?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })
    expect(disable.status).toBe(200)
    expect(convex.setWorkspaceAgentExtensionEnabled).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "review",
      enabled: false,
    })
    expect(svc.telemetry.capture).toHaveBeenCalledWith("user_1", "agent_extension.disable", {
      id: "review",
      scope: "workspace",
      workspaceId: "ws_1",
    })
  })

  test("workspace list includes effective policy provenance for disabled installs", async () => {
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        listWorkspaceAgentExtensions: vi.fn(async () => [{
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            scope: "workspace",
            enabled: true,
            targets: ["cursor"],
            installed_at: 1,
            updated_at: 1,
          },
          lock: {
            source: { type: "github", owner: "acme", repo: "review" },
            resolved_sha: "abcdef1234567890",
            manifest_digests: { package: "abc" },
            component_digests: { package: "abc" },
            targets: ["cursor"],
          },
        }]),
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      agentExtensionPolicyOverrides: async (input) => input.scope === "workspace"
        ? [{ id: "review", scope: "org", enabled: false, reason: "blocked by org policy" }]
        : [],
    })

    const list = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      desired: { installs: [{ id: "review", enabled: true }] },
      effective: {
        review: {
          enabled: false,
          source: "org",
          reason: "blocked by org policy",
        },
      },
    })
  })

  test("workspace install rejects same id from a different source before Control Plane upsert", async () => {
    const upsertWorkspaceAgentExtension = vi.fn(async () => ({}))
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {}),
        listWorkspaceAgentExtensions: vi.fn(async () => [{
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "trusted", repo: "review" },
            scope: "workspace",
            enabled: true,
            targets: ["cursor"],
            installed_at: 1,
            updated_at: 1,
          },
          lock: {
            source: { type: "github", owner: "trusted", repo: "review" },
            resolved_sha: "abcdef1234567890",
            manifest_digests: { package: "abc" },
            component_digests: { package: "abc" },
            targets: ["cursor"],
          },
        }]),
        upsertWorkspaceAgentExtension,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension: async () => ({
        id: "review",
        package: { type: "standalone-skill", name: "review", skill_path: "SKILL.md" },
        cache: { path: "/cache/review", checksum: "def", resolvedSha: "fedcba9876543210" },
        record: {
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "attacker", repo: "review" },
            scope: "workspace",
            enabled: true,
            targets: ["cursor"],
            installed_at: 2,
            updated_at: 2,
          },
          lock: {
            source: { type: "github", owner: "attacker", repo: "review" },
            resolved_sha: "fedcba9876543210",
            manifest_digests: { package: "def" },
            component_digests: { package: "def" },
            targets: ["cursor"],
          },
        },
      }),
    })

    const install = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      body: JSON.stringify({ source: "attacker/review", id: "review", targets: ["cursor"] }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_1",
      },
    })

    expect(install.status).toBe(409)
    await expect(install.json()).resolves.toMatchObject({
      error: {
        code: "agent_extension_source_conflict",
        details: {
          id: "review",
          existingSource: { owner: "trusted", repo: "review" },
          requestedSource: { owner: "attacker", repo: "review" },
        },
      },
    })
    expect(upsertWorkspaceAgentExtension).not.toHaveBeenCalled()
  })

  test("workspace install absorbs a legacy same-source record instead of filing a second row", async () => {
    const upsertWorkspaceAgentExtension = vi.fn(async () => ({}))
    const deleteWorkspaceAgentExtension = vi.fn(async () => ({ ok: true }))
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {}),
        listWorkspaceAgentExtensions: vi.fn(async () => [legacyPdfRecord()]),
        upsertWorkspaceAgentExtension,
        deleteWorkspaceAgentExtension,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension: async () => resolvedPinnedPdf(),
    })

    const install = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      body: JSON.stringify({
        source: "https://github.com/anthropics/skills/tree/main/skills/pdf",
        id: "anthropic-skill-pdf",
        targets: ["claude"],
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_1",
      },
    })

    expect(install.status).toBe(201)
    // The absorbed record keeps its enablement and install time — a disabled
    // legacy install must not come back to life just because it was re-keyed.
    await expect(install.json()).resolves.toMatchObject({
      id: "anthropic-skill-pdf",
      desired: { id: "anthropic-skill-pdf", enabled: false, installed_at: 5 },
    })
    expect(upsertWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: "ws_1",
      extensionId: "anthropic-skill-pdf",
      desired: expect.objectContaining({ id: "anthropic-skill-pdf", enabled: false, installed_at: 5 }),
    }))
    expect(deleteWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "pdf",
    })
  })

  test("authority-less workspace install absorbs a legacy same-source mirror record", async () => {
    await mirrorWorkspaceAgentExtensionRecord({
      workspaceId: "ws_mirror",
      record: legacyPdfRecord(),
    })
    const app = createAgentConfigRoutes({
      homeDir: home,
      resolveGitHubWorkspaceAgentExtension: async () => resolvedPinnedPdf(),
    })

    const install = await app.request("/extensions?scope=workspace&workspaceId=ws_mirror", {
      method: "POST",
      body: JSON.stringify({
        source: "https://github.com/anthropics/skills/tree/main/skills/pdf",
        id: "anthropic-skill-pdf",
        targets: ["claude"],
      }),
      headers: { "Content-Type": "application/json" },
    })

    expect(install.status).toBe(201)
    await expect(install.json()).resolves.toMatchObject({
      id: "anthropic-skill-pdf",
      desired: { id: "anthropic-skill-pdf", enabled: false, installed_at: 5 },
    })
    const records = await readMirroredWorkspaceAgentExtensions({ workspaceId: "ws_mirror" })
    expect(records.map((item) => item.desired.id)).toEqual(["anthropic-skill-pdf"])
    expect(records[0]).toMatchObject({
      desired: { enabled: false, installed_at: 5 },
      lock: { resolved_sha: "fedcba9876543210" },
    })
  })

  test("workspace enable and disable resolve a legacy same-source record via the catalog id", async () => {
    const setWorkspaceAgentExtensionEnabled = vi.fn(async (_auth: unknown, args: { extensionId: string }) => {
      if (args.extensionId !== "pdf") throw new Error("Agent Extension not found")
      return {}
    })
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        listWorkspaceAgentExtensions: vi.fn(async () => [legacyPdfRecord()]),
        setWorkspaceAgentExtensionEnabled,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
    })

    const res = await app.request("/extensions/anthropic-skill-pdf/enable?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, enabled: true })
    expect(setWorkspaceAgentExtensionEnabled).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "anthropic-skill-pdf",
      enabled: true,
    })
    expect(setWorkspaceAgentExtensionEnabled).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "pdf",
      enabled: true,
    })
  })

  test("workspace uninstall resolves a legacy same-source record via the catalog id", async () => {
    const deleteWorkspaceAgentExtension = vi.fn(async () => ({ ok: true }))
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        listWorkspaceAgentExtensions: vi.fn(async () => [legacyPdfRecord()]),
        deleteWorkspaceAgentExtension,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
    })

    const res = await app.request("/extensions/anthropic-skill-pdf?scope=workspace&workspaceId=ws_1", {
      method: "DELETE",
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(deleteWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "pdf",
    })
  })

  test("workspace update normalizes a legacy same-source record onto the requested catalog id", async () => {
    const calls: unknown[] = []
    const upsertWorkspaceAgentExtension = vi.fn(async () => ({}))
    const deleteWorkspaceAgentExtension = vi.fn(async () => ({ ok: true }))
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {}),
        listWorkspaceAgentExtensions: vi.fn(async () => [legacyPdfRecord()]),
        upsertWorkspaceAgentExtension,
        deleteWorkspaceAgentExtension,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension: async (input) => {
        calls.push(input)
        return resolvedPinnedPdf(input.id ?? "anthropic-skill-pdf", input.targets as Array<"claude"> ?? ["claude"])
      },
    })

    const update = await app.request("/extensions/anthropic-skill-pdf/update?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })

    expect(update.status).toBe(200)
    await expect(update.json()).resolves.toMatchObject({
      id: "anthropic-skill-pdf",
      desired: {
        id: "anthropic-skill-pdf",
        enabled: false,
        installed_at: 5,
        updated_at: 200,
      },
      lock: { resolved_sha: "fedcba9876543210" },
    })
    expect(calls).toEqual([{
      source: "https://github.com/anthropics/skills/tree/main/skills/pdf",
      workspaceId: "ws_1",
      id: "anthropic-skill-pdf",
      targets: ["claude"],
      now: expect.any(Number),
    }])
    expect(upsertWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      extensionId: "anthropic-skill-pdf",
      desired: expect.objectContaining({ id: "anthropic-skill-pdf", enabled: false, installed_at: 5 }),
    }))
    expect(deleteWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "pdf",
    })
  })

  test("workspace list reads policy overrides from Control Plane authority by default", async () => {
    const listAgentExtensionPolicyOverrides = vi.fn(async () => [{
      id: "review",
      scope: "org" as const,
      enabled: false,
      reason: "blocked by org policy",
    }])
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        listWorkspaceAgentExtensions: vi.fn(async () => [{
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            scope: "workspace",
            enabled: true,
            targets: ["cursor"],
            installed_at: 1,
            updated_at: 1,
          },
          lock: {
            source: { type: "github", owner: "acme", repo: "review" },
            resolved_sha: "abcdef1234567890",
            manifest_digests: { package: "abc" },
            component_digests: { package: "abc" },
            targets: ["cursor"],
          },
        }]),
        listAgentExtensionPolicyOverrides,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
    })

    const list = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      effective: {
        review: {
          enabled: false,
          source: "org",
          reason: "blocked by org policy",
        },
      },
    })
    expect(listAgentExtensionPolicyOverrides).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
    })
  })

  test("workspace list tolerates older Control Plane deployments without policy overrides", async () => {
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        listWorkspaceAgentExtensions: vi.fn(async () => [{
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            scope: "workspace",
            enabled: true,
            targets: ["cursor"],
            installed_at: 1,
            updated_at: 1,
          },
          lock: {
            source: { type: "github", owner: "acme", repo: "review" },
            resolved_sha: "abcdef1234567890",
            manifest_digests: { package: "abc" },
            component_digests: { package: "abc" },
            targets: ["cursor"],
          },
        }]),
        listAgentExtensionPolicyOverrides: vi.fn(async () => {
          throw new Error("Could not find public function for 'agentExtensionPolicies:list'. Did you forget to run `npx convex dev`?")
        }),
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
    })

    const list = await app.request("/extensions?scope=workspace&workspaceId=ws_1", {
      headers: { Authorization: "Bearer user_1" },
    })

    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      desired: { installs: [{ id: "review", enabled: true }] },
      effective: {
        review: {
          enabled: true,
          source: "desired",
        },
      },
    })
  })

  test("workspace update reads existing desired source from Control Plane authority", async () => {
    const calls: unknown[] = []
    const listWorkspaceAgentExtensions = vi.fn(async () => [{
      desired: {
        id: "review",
        package_name: "review",
        source: { type: "github", owner: "acme", repo: "review" },
        scope: "workspace",
        enabled: true,
        targets: ["cursor"],
        installed_at: 1,
        updated_at: 1,
      },
      lock: { resolved_sha: "abcdef1234567890" },
    }])
    const upsertWorkspaceAgentExtension = vi.fn(async () => ({}))
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {}),
        listWorkspaceAgentExtensions,
        upsertWorkspaceAgentExtension,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension: async (input) => {
        calls.push(input)
        return {
          id: input.id ?? "review",
          package: { type: "standalone-skill", name: "review", skill_path: "SKILL.md" },
          cache: { path: "/cache/review", checksum: "def", resolvedSha: "fedcba9876543210" },
          record: {
            desired: {
              id: input.id ?? "review",
              package_name: "review",
              source: { type: "github", owner: "acme", repo: "review" },
              scope: "workspace",
              enabled: true,
              targets: input.targets ?? ["cursor"],
              installed_at: 1,
              updated_at: 200,
            },
            lock: {
              source: { type: "github", owner: "acme", repo: "review" },
              resolved_sha: "fedcba9876543210",
              manifest_digests: { package: "def" },
              component_digests: { package: "def" },
              targets: input.targets ?? ["cursor"],
            },
          },
        }
      },
    })

    const update = await app.request("/extensions/review/update?scope=workspace&workspaceId=ws_1", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })

    expect(update.status).toBe(200)
    await expect(update.json()).resolves.toMatchObject({
      id: "review",
      desired: { id: "review", scope: "workspace", updated_at: 200 },
      lock: { resolved_sha: "fedcba9876543210" },
    })
    expect(listWorkspaceAgentExtensions).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
    })
    expect(calls).toEqual([{
      source: "acme/review",
      workspaceId: "ws_1",
      id: "review",
      targets: ["cursor"],
      now: expect.any(Number),
    }])
    expect(upsertWorkspaceAgentExtension).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      extensionId: "review",
      packageName: "review",
      desired: expect.objectContaining({ id: "review", scope: "workspace" }),
      lock: expect.objectContaining({ resolved_sha: "fedcba9876543210" }),
    })
  })

  test("workspace enable maps Control Plane workspace misses to not found", async () => {
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        setWorkspaceAgentExtensionEnabled: vi.fn(async () => {
          throw new Error("Workspace not found")
        }),
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
    })

    const res = await app.request("/extensions/review/enable?scope=workspace&workspaceId=ws_missing", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_not_found",
        message: "Workspace not found",
      },
    })
  })

  test("workspace install maps authority errors before resolving package installs", async () => {
    const resolveGitHubWorkspaceAgentExtension = vi.fn()
    const upsertWorkspaceAgentExtension = vi.fn(async () => ({}))
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {
          throw new Error("Workspace not found")
        }),
        upsertWorkspaceAgentExtension,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension,
    })

    const res = await app.request("/extensions?scope=workspace&workspaceId=ws_missing", {
      method: "POST",
      body: JSON.stringify({ source: "acme/review", targets: ["cursor"] }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user_1",
      },
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_not_found",
        message: "Workspace not found",
      },
    })
    expect(resolveGitHubWorkspaceAgentExtension).not.toHaveBeenCalled()
    expect(upsertWorkspaceAgentExtension).not.toHaveBeenCalled()
  })

  test("workspace update maps authority errors before resolving package updates", async () => {
    const listWorkspaceAgentExtensions = vi.fn(async () => [])
    const resolveGitHubWorkspaceAgentExtension = vi.fn()
    const app = createAgentConfigRoutes({
      services: services({
        usersMe: async () => ({}),
        authorizeWorkspaceAgentExtensionsAdmin: vi.fn(async () => {
          throw new Error("Workspace not found")
        }),
        listWorkspaceAgentExtensions,
      } as unknown as NonNullable<ControlPlaneServices["authority"]>),
      authConfig,
      verifier,
      resolveGitHubWorkspaceAgentExtension,
    })

    const res = await app.request("/extensions/review/update?scope=workspace&workspaceId=ws_missing", {
      method: "POST",
      headers: { Authorization: "Bearer user_1" },
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "workspace_not_found",
        message: "Workspace not found",
      },
    })
    expect(listWorkspaceAgentExtensions).not.toHaveBeenCalled()
    expect(resolveGitHubWorkspaceAgentExtension).not.toHaveBeenCalled()
  })

  test("loopback local browser requests can read local Agent Config state with bearer auth attached", async () => {
    const app = createAgentConfigRoutes({ authConfig, verifier, homeDir: home })

    const res = await app.request("http://127.0.0.1/commands", {
      headers: {
        Authorization: "Bearer user_1",
        Origin: "http://localhost:4444",
      },
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test("local Agent Config routes return structured validation errors", async () => {
    const app = route()

    for (const item of [
      {
        request: new Request("http://127.0.0.1/harness", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        status: 400,
        error: { code: "agent_config_harness_required", message: "harness is required" },
      },
      {
        request: new Request("http://127.0.0.1/harness", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "bad-runner" }),
        }),
        status: 400,
        error: { code: "agent_config_harness_required", message: "harness is required" },
      },
      {
        request: new Request("http://127.0.0.1/harness/options"),
        status: 400,
        error: { code: "agent_config_workspace_required", message: "workspaceId or directory is required" },
      },
      {
        request: new Request("http://127.0.0.1/mcp/bad%21", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "stdio", command: "node" }),
        }),
        status: 400,
        error: {
          code: "agent_config_mcp_name_invalid",
          message: "Invalid server name (alphanumeric, dash, underscore only)",
        },
      },
      {
        request: new Request("http://127.0.0.1/mcp/docs", { method: "POST" }),
        status: 400,
        error: { code: "agent_config_invalid_body", message: "Invalid JSON body" },
      },
      {
        request: new Request("http://127.0.0.1/mcp/docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "bad" }),
        }),
        status: 400,
        error: { code: "agent_config_mcp_type_invalid", message: "type must be 'stdio' or 'remote'" },
      },
      {
        request: new Request("http://127.0.0.1/mcp/docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "stdio" }),
        }),
        status: 400,
        error: { code: "agent_config_mcp_command_required", message: "command is required for stdio servers" },
      },
      {
        request: new Request("http://127.0.0.1/mcp/docs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "remote" }),
        }),
        status: 400,
        error: { code: "agent_config_mcp_url_required", message: "url is required for remote servers" },
      },
      {
        request: new Request("http://127.0.0.1/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "review" }),
        }),
        status: 400,
        error: { code: "agent_config_command_invalid_body", message: "name and content are required" },
      },
    ]) {
      const res = await app.request(item.request)
      expect(res.status).toBe(item.status)
      await expect(res.json()).resolves.toEqual({ error: item.error })
    }
  })

  test("local Agent Config routes return structured not-found errors", async () => {
    const app = route()

    for (const item of [
      {
        request: new Request("http://127.0.0.1/mcp/missing", { method: "DELETE" }),
        error: { code: "agent_config_mcp_not_found", message: "MCP server not found" },
      },
      {
        request: new Request("http://127.0.0.1/commands/missing"),
        error: { code: "agent_config_command_not_found", message: "Command not found" },
      },
      {
        request: new Request("http://127.0.0.1/commands/missing", { method: "DELETE" }),
        error: { code: "agent_config_command_not_found", message: "Command not found" },
      },
    ]) {
      const res = await app.request(item.request)
      expect(res.status).toBe(404)
      await expect(res.json()).resolves.toEqual({ error: item.error })
    }
  })

  test("signed non-loopback callers cannot read or mutate local Agent Config state", async () => {
    const app = createAgentConfigRoutes({ authConfig, verifier })

    for (const item of [
      { method: "GET", path: `/harness?directory=${encodeURIComponent(project)}`, label: "Local harness configuration" },
      { method: "POST", path: "/harness", label: "Local harness configuration", body: { id: "claude", access: "acp", directory: project } },
      { method: "POST", path: "/harness/model", label: "Local harness configuration", body: { model: "sonnet", directory: project } },
      { method: "GET", path: `/harness/options?directory=${encodeURIComponent(project)}&harness=claude`, label: "Local harness configuration" },
      { method: "GET", path: "/mcp", label: "Local MCP config" },
      { method: "POST", path: "/mcp/docs", label: "Local MCP config", body: { type: "stdio", command: "node" } },
      { method: "GET", path: `/agents?directory=${encodeURIComponent(project)}&type=claude-acp`, label: "Local agent profile config" },
      { method: "GET", path: "/commands", label: "Local command config" },
      { method: "POST", path: "/commands", label: "Local command config", body: { name: "review", content: "Review" } },
      { method: "GET", path: `/extensions?directory=${encodeURIComponent(project)}`, label: "Local Agent Extensions" },
      { method: "POST", path: `/extensions?directory=${encodeURIComponent(project)}`, label: "Local Agent Extensions", body: { source: "acme/review" } },
      { method: "GET", path: `/extensions/scan?directory=${encodeURIComponent(project)}`, label: "Local Agent Extensions scan" },
      { method: "POST", path: "/extensions/adopt", label: "Local Agent Extensions scan", body: { directory: project, path: "AGENTS.md" } },
      { method: "POST", path: "/extensions/ignore", label: "Local Agent Extensions scan", body: { directory: project, path: "AGENTS.md" } },
      { method: "POST", path: "/extensions/detach", label: "Local Agent Extensions scan", body: { directory: project, path: "AGENTS.md" } },
    ]) {
      const res = await app.request(`https://control.example.test${item.path}`, {
        method: item.method,
        headers: {
          Authorization: "Bearer user_1",
          ...(item.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(item.body ? { body: JSON.stringify(item.body) } : {}),
      })
      expect(res.status).toBe(403)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "local_only_projection_route",
          message: `${item.label} is local-only and is not available through signed/team Control Plane access`,
        },
      })
    }
  })

  test("signed non-loopback Agent Config requests fail closed before bearer auth is configured", async () => {
    const app = createAgentConfigRoutes({ authConfig, verifier })

    const res = await app.request("https://control.example.test/commands")

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "missing_bearer_token",
        message: "Authorization: Bearer token is required",
      },
    })
  })

  // Catalog and machine-scan routes that the
  // marketplace-panel reads. Regression coverage so the wiring isn't
  // dropped again.
  test("GET /extensions/catalog returns the curated catalog", async () => {
    const res = await route().request("/extensions/catalog")
    expect(res.status).toBe(200)
    const body = await res.json() as { categories: unknown[]; entries: unknown[] }
    expect(Array.isArray(body.categories)).toBe(true)
    expect(Array.isArray(body.entries)).toBe(true)
    // The catalog is curated, not empty — every entry has a stable id +
    // an installable source.
    expect(body.entries.length).toBeGreaterThan(0)
    for (const entry of body.entries as Array<{ id: string; kind: string; source: string; recommendedTargets?: string[] }>) {
      expect(typeof entry.id).toBe("string")
      expect(entry.id.length).toBeGreaterThan(0)
      expect(typeof entry.source).toBe("string")
      expect(entry.source.length).toBeGreaterThan(0)
      if (entry.kind === "mcp") expect(entry.recommendedTargets).toContain("opencode")
    }
  })

  test("GET /extensions/machine-scan returns an array (possibly empty in test env)", async () => {
    const res = await route().request("/extensions/machine-scan")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
