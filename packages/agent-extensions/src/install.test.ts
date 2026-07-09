import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import {
  agentExtensionStateRoot,
  installedStatePath,
  writeDesiredExtensionState,
} from "./state"
import { digestDirectory } from "./cache"
import { lockStatePath, writeExtensionLock } from "./lock"
import { materializedRecordPath, readMaterializedRuntimeRecord } from "./materialization"
import { AgentExtensionConflictError, disableAgentExtension, enableAgentExtension, installCachedAgentExtension, uninstallAgentExtension, updateAgentExtension } from "./install"

const root = path.join(os.tmpdir(), `agent-extensions-install-${randomUUID().slice(0, 8)}`)
const source = path.join(root, "source")
const project = path.join(root, "project")
const data = path.join(root, "data")
const home = path.join(root, "home")

async function writeSource(file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true })
  await fs.writeFile(path.join(source, file), content)
}

async function expectMaterializedDirectory(target: string) {
  const stat = await fs.lstat(target)
  expect(stat.isDirectory() || stat.isSymbolicLink()).toBe(true)
}

describe("cached Agent Extension install flow", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(home, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("installs a standalone skill for project scope", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")

    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })

    expect(result.materialized.status).toBe("applied")
    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "review",
        package_name: path.basename(result.cache.path),
        enabled: true,
        targets: ["cursor"],
      }],
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "lock.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        review: {
          resolved_sha: "abcdef1234567890",
          targets: ["cursor"],
        },
      },
    })
    await expectMaterializedDirectory(path.join(project, ".cursor", "skills", path.basename(result.cache.path)))
    await expect(fs.readFile(path.join(project, ".cursor", "skills", path.basename(result.cache.path), "SKILL.md"), "utf8")).resolves.toContain("name: review")
  })

  test("installs a standalone skill for OpenCode project scope", async () => {
    await writeSource("SKILL.md", "---\nname: review\ndescription: Review code\n---\n")

    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["opencode"],
      id: "review",
      now: 100,
    })

    expect(result.materialized.status).toBe("applied")
    await expectMaterializedDirectory(path.join(project, ".opencode", "skills", path.basename(result.cache.path)))
    await expect(fs.readFile(path.join(project, ".opencode", "skills", path.basename(result.cache.path), "SKILL.md"), "utf8")).resolves.toContain("name: review")
  })

  test("installs a standalone skill for machine scope", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")

    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "machine",
      dataRoot: data,
      homeDir: home,
      targets: ["claude", "codex", "cursor"],
      id: "review",
      now: 100,
    })

    expect(result.materialized.status).toBe("applied")
    await expectMaterializedDirectory(path.join(home, ".claude", "skills", path.basename(result.cache.path)))
    await expectMaterializedDirectory(path.join(home, ".codex", "skills", path.basename(result.cache.path)))
    await expectMaterializedDirectory(path.join(home, ".cursor", "skills", path.basename(result.cache.path)))
    await expect(fs.readFile(path.join(home, ".cursor", "skills", path.basename(result.cache.path), "SKILL.md"), "utf8")).resolves.toContain("name: review")
    await expect(fs.readFile(path.join(data, "agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "review",
        scope: "machine",
        enabled: true,
        targets: ["claude", "codex", "cursor"],
      }],
    })
  })

  test("installs a Cursor-native plugin into the local plugin directory", async () => {
    await writeSource(".cursor-plugin/plugin.json", JSON.stringify({ name: "cursor-review" }))

    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "cursor-review" },
      resolvedSha: "abcdef1234567890",
      scope: "machine",
      dataRoot: data,
      homeDir: home,
      id: "cursor-review",
      now: 100,
    })

    expect(result.materialized.status).toBe("partial")
    expect(result.materialized.components).toMatchObject([
      {
        runner: "opencode",
        status: "skipped",
        reason: "native plugin install path not verified",
      },
      {
        runner: "claude",
        status: "skipped",
        reason: "native plugin install path not verified",
      },
      {
        runner: "codex",
        status: "skipped",
        reason: "native plugin install path not verified",
      },
      {
        runner: "cursor",
        status: "applied",
      },
    ])
    await expectMaterializedDirectory(path.join(home, ".cursor", "plugins", "local", "cursor-review"))
    await expect(fs.readFile(path.join(home, ".cursor", "plugins", "local", "cursor-review", ".cursor-plugin", "plugin.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({ name: "cursor-review" })
    await expect(fs.readFile(path.join(data, "agent-extensions", "materialized.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        "cursor-review": {
          package_name: "cursor-review",
          status: "partial",
        },
      },
    })
  })

  test("installs standalone MCP for Cursor and Codex project targets", async () => {
    await writeSource("mcp.json", JSON.stringify({ servers: { docs: { command: "node" } } }))

    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "docs-mcp" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor", "codex"],
      id: "docs-mcp",
      now: 100,
    })

    expect(result.materialized.status).toBe("applied")
    expect(result.materialized.components).toEqual([
      {
        runner: "cursor",
        component: "docs",
        type: "mcp",
        status: "applied",
        path: path.join(project, ".cursor", "mcp.json"),
      },
      {
        runner: "codex",
        component: "docs",
        type: "mcp",
        status: "applied",
        path: path.join(project, ".codex", "config.toml"),
      },
    ])
    await expect(fs.readFile(path.join(project, ".codex", "config.toml"), "utf8")).resolves.toBe([
      "[mcp_servers.docs]",
      'command = "node"',
      "",
    ].join("\n"))
  })

  test("installs first-party Claxedo MCP with managed local env and no local auth token", async () => {
    const previousServerUrl = process.env.CLAXEDO_SERVER_URL
    const previousWorkspaceId = process.env.CLAXEDO_WR_WORKSPACE_ID
    process.env.CLAXEDO_SERVER_URL = "http://127.0.0.1:8123"
    process.env.CLAXEDO_WR_WORKSPACE_ID = "ws_docker"

    try {
      await writeSource("mcp.json", JSON.stringify({
        servers: {
          claxedo: {
            command: "npx",
            args: ["-y", "@claxedo/mcp"],
            env: {
              CLAXEDO_SERVER_URL: "http://package.example",
              OPENCODE_API_DIR: "/package-dir",
              CLAXEDO_WORKSPACE_ID: "ws_package",
              CLAXEDO_LOCAL_TOKEN: "local-token",
              CLAXEDO_AUTH_TOKEN: "auth-token",
              CLAXEDO_API_TOKEN: "api-token",
              CLAXEDO_MCP_BROKER_TOKEN: "broker-token",
              OTHER: "kept",
            },
          },
        },
      }))

      await installCachedAgentExtension({
        sourceRoot: source,
        source: {
          type: "github",
          owner: "kyashrathore",
          repo: "Claxedo",
          ref: "dev",
          package_path: "packages/claxedo-mcp",
        },
        resolvedSha: "abcdef1234567890",
        scope: "project",
        projectDir: project,
        dataRoot: data,
        homeDir: home,
        targets: ["cursor"],
        id: "claxedo-mcp",
        now: 100,
      })

      const cursorConfig = JSON.parse(await fs.readFile(path.join(project, ".cursor", "mcp.json"), "utf8"))
      expect(cursorConfig).toMatchObject({
        mcpServers: {
          claxedo: {
            command: "npx",
            args: ["-y", "@claxedo/mcp"],
            env: {
              CLAXEDO_SERVER_URL: "http://127.0.0.1:8123",
              OPENCODE_API_DIR: project,
              CLAXEDO_WORKSPACE_ID: "ws_docker",
              OTHER: "kept",
            },
          },
        },
      })
      expect(cursorConfig.mcpServers.claxedo.env).not.toHaveProperty("CLAXEDO_LOCAL_TOKEN")
      expect(cursorConfig.mcpServers.claxedo.env).not.toHaveProperty("CLAXEDO_AUTH_TOKEN")
      expect(cursorConfig.mcpServers.claxedo.env).not.toHaveProperty("CLAXEDO_API_TOKEN")
      expect(cursorConfig.mcpServers.claxedo.env).not.toHaveProperty("CLAXEDO_MCP_BROKER_TOKEN")
    } finally {
      if (previousServerUrl === undefined) delete process.env.CLAXEDO_SERVER_URL
      else process.env.CLAXEDO_SERVER_URL = previousServerUrl
      if (previousWorkspaceId === undefined) delete process.env.CLAXEDO_WR_WORKSPACE_ID
      else process.env.CLAXEDO_WR_WORKSPACE_ID = previousWorkspaceId
    }
  })

  test("does not treat package metadata as first-party Claxedo MCP access", async () => {
    await writeSource("mcp.json", JSON.stringify({
      firstParty: "claxedo",
      servers: {
        claxedo: {
          command: "node",
          args: ["server.js"],
          env: { OTHER: "kept" },
        },
      },
    }))

    await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "claxedo-lookalike", ref: "main", package_path: "packages/claxedo-mcp" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "claxedo-mcp",
      now: 100,
    })

    await expect(fs.readFile(path.join(project, ".cursor", "mcp.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      mcpServers: {
        claxedo: {
          command: "node",
          args: ["server.js"],
          env: { OTHER: "kept" },
        },
      },
    })
  })

  test("installs standalone MCP for OpenCode project target", async () => {
    await writeSource("mcp.json", JSON.stringify({ servers: { docs: { command: "node", args: ["server.js"] } } }))

    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "docs-mcp" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["opencode"],
      id: "docs-mcp",
      now: 100,
    })

    expect(result.materialized.status).toBe("applied")
    expect(result.materialized.components).toEqual([{
      runner: "opencode",
      component: "docs",
      type: "mcp",
      status: "applied",
      path: path.join(project, ".opencode", "opencode.jsonc"),
    }])
    await expect(fs.readFile(path.join(project, ".opencode", "opencode.jsonc"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      mcp: {
        docs: {
          type: "local",
          command: ["node", "server.js"],
          enabled: true,
        },
      },
    })
  })

  test("reinstalling the same id/source preserves installed_at while updating the lock", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review-updated\n---\n")

    await expect(installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef9999999999",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 300,
    })).resolves.toMatchObject({
      materialized: {
        resolved_sha: "abcdef9999999999",
        enabled: true,
      },
    })

    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "review",
        enabled: true,
        installed_at: 100,
        updated_at: 300,
      }],
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "lock.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        review: { resolved_sha: "abcdef9999999999" },
      },
    })
  })

  test("updating a disabled install keeps it disabled in desired state", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const first = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    const target = path.join(project, ".cursor", "skills", path.basename(first.cache.path))
    await disableAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      now: 200,
    })
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review-updated\n---\n")

    await expect(installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef9999999999",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 300,
    })).resolves.toMatchObject({
      materialized: {
        enabled: false,
        status: "disabled",
        resolved_sha: "abcdef9999999999",
      },
    })

    await expect(fs.stat(target)).rejects.toThrow()
    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "review",
        enabled: false,
        installed_at: 100,
        updated_at: 300,
      }],
    })
  })

  test("update recreates missing lock state while preserving installed_at", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    await fs.rm(path.join(project, ".agent-extensions", "lock.json"), { force: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review-updated\n---\n")

    await expect(updateAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      now: 300,
      fetchPackage: async () => ({
        path: source,
        resolvedSha: "abcdef9999999999",
        checksum: await digestDirectory(source),
      }),
    })).resolves.toMatchObject({
      materialized: {
        resolved_sha: "abcdef9999999999",
        enabled: true,
        status: "applied",
      },
    })

    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "review",
        installed_at: 100,
        updated_at: 300,
      }],
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "lock.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        review: { resolved_sha: "abcdef9999999999" },
      },
    })
  })

  test("update refreshes project source installs from the project package path", async () => {
    const packagePath = path.join(project, "packages", "review")
    await fs.mkdir(packagePath, { recursive: true })
    await fs.writeFile(path.join(packagePath, "SKILL.md"), "---\nname: review\n---\n")
    const firstDigest = await digestDirectory(packagePath)
    await installCachedAgentExtension({
      sourceRoot: project,
      source: { type: "project", package_path: "packages/review" },
      resolvedSha: firstDigest,
      packagePath: "packages/review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    await fs.writeFile(path.join(packagePath, "SKILL.md"), "---\nname: review-updated\n---\n")
    const updatedDigest = await digestDirectory(packagePath)

    await expect(updateAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      now: 300,
    })).resolves.toMatchObject({
      materialized: {
        resolved_sha: updatedDigest,
        enabled: true,
        status: "applied",
      },
    })

    await expect(fs.readFile(path.join(project, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toContain("review-updated")
    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "review",
        installed_at: 100,
        updated_at: 300,
      }],
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "lock.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        review: {
          source: { type: "project", package_path: "packages/review" },
          resolved_sha: updatedDigest,
          package_path: "packages/review",
        },
      },
    })
  })

  test("lifecycle commands wait for the shared state lock instead of interleaving", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const lockDir = path.join(project, ".agent-extensions", ".replay-lock")
    await fs.mkdir(lockDir, { recursive: true })

    let settled = false
    const pending = installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    }).then((result) => {
      settled = true
      return result
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(settled).toBe(false)

    await fs.rm(lockDir, { recursive: true, force: true })
    const result = await pending
    expect(result.materialized.status).toBe("applied")
    await expect(fs.stat(lockDir)).rejects.toThrow()
  })

  test("a conflict on a later target keeps earlier applied components owned so retry succeeds", async () => {
    await writeSource("mcp.json", JSON.stringify({ servers: { docs: { command: "node" } } }))
    // A foreign (unowned) server already occupies the cursor target file.
    await fs.mkdir(path.join(project, ".cursor"), { recursive: true })
    await fs.writeFile(path.join(project, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { docs: { command: "someone-else" } },
    }, null, 2))
    const input = {
      sourceRoot: source,
      source: { type: "github" as const, owner: "acme", repo: "docs-mcp" },
      resolvedSha: "abcdef1234567890",
      scope: "project" as const,
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["claude" as const, "cursor" as const],
      id: "docs-mcp",
      now: 100,
    }

    await expect(installCachedAgentExtension(input)).rejects.toThrow("already exists")

    // The claude component applied before the cursor conflict; it must be
    // recorded as owned, otherwise every retry conflicts with our own output.
    const record = await readMaterializedRuntimeRecord(
      materializedRecordPath(agentExtensionStateRoot({ scope: "project", projectDir: project })),
    )
    expect(record.packages["docs-mcp"]?.status).toBe("failed")
    expect(record.packages["docs-mcp"]?.components).toContainEqual({
      runner: "claude",
      component: "docs",
      type: "mcp",
      status: "applied",
      path: path.join(project, ".mcp.json"),
    })

    await fs.rm(path.join(project, ".cursor", "mcp.json"))
    const retry = await installCachedAgentExtension({ ...input, now: 200 })
    expect(retry.materialized.status).toBe("applied")
  })

  test("same id from a different source returns a structured conflict", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })

    await expect(installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "other", repo: "review" },
      resolvedSha: "abcdef9999999999",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 300,
    })).rejects.toMatchObject({
      name: "AgentExtensionConflictError",
      code: "agent_extension_source_conflict",
      details: {
        id: "review",
        existingSource: { owner: "acme" },
        requestedSource: { owner: "other" },
      },
    } satisfies Partial<AgentExtensionConflictError>)
  })

  test("disable removes owned materialized artifacts and preserves desired state", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    const target = path.join(project, ".cursor", "skills", path.basename(result.cache.path))

    await expect(disableAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      now: 200,
    })).resolves.toMatchObject({
      id: "review",
      materialized: {
        enabled: false,
        status: "disabled",
      },
    })

    await expect(fs.stat(target)).rejects.toThrow()
    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{ id: "review", enabled: false, updated_at: 200 }],
    })
  })

  test("enable replays a disabled install from the cache", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    const target = path.join(project, ".cursor", "skills", path.basename(result.cache.path))
    await disableAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      now: 200,
    })

    await expect(enableAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      now: 300,
    })).resolves.toMatchObject({
      id: "review",
      materialized: {
        enabled: true,
        status: "applied",
      },
    })

    await expectMaterializedDirectory(target)
    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toContain("name: review")
    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{ id: "review", enabled: true, updated_at: 300 }],
    })
  })

  test("enable validates cached package bytes before replay", async () => {
    await writeSource("SKILL.md", "---\nname: review\n---\n")
    const result = await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "review" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "review",
      now: 100,
    })
    await disableAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      now: 200,
    })
    await fs.writeFile(path.join(result.cache.path, "SKILL.md"), "---\nname: tampered\n---\n")

    await expect(enableAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      now: 300,
    })).rejects.toThrow("cache checksum mismatch")
  })

  test("uninstall removes desired, lock, materialized, and owned artifacts only", async () => {
    await writeSource("mcp.json", JSON.stringify({ servers: { docs: { command: "node" } } }))
    await installCachedAgentExtension({
      sourceRoot: source,
      source: { type: "github", owner: "acme", repo: "docs-mcp" },
      resolvedSha: "abcdef1234567890",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      homeDir: home,
      targets: ["cursor"],
      id: "docs-mcp",
      now: 100,
    })
    const mcp = path.join(project, ".cursor", "mcp.json")
    await fs.writeFile(mcp, JSON.stringify({
      mcpServers: {
        docs: { command: "node", args: [], env: {} },
        unmanaged: { command: "other", args: [], env: {} },
      },
    }))

    await expect(uninstallAgentExtension({
      id: "docs-mcp",
      scope: "project",
      projectDir: project,
      dataRoot: data,
    })).resolves.toMatchObject({
      status: "applied",
    })

    await expect(fs.readFile(mcp, "utf8").then(JSON.parse)).resolves.toEqual({
      mcpServers: {
        unmanaged: { command: "other", args: [], env: {} },
      },
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      installs: [],
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "lock.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {},
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "materialized.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {},
    })
  })

  test("uninstall cleans up desired and lock state even when materialization never completed", async () => {
    const stateRoot = agentExtensionStateRoot({
      scope: "project",
      projectDir: project,
      dataRoot: data,
    })
    await writeDesiredExtensionState(installedStatePath({
      scope: "project",
      projectDir: project,
      dataRoot: data,
    }), {
      version: 1,
      installs: [{
        id: "review",
        package_name: "review",
        source: { type: "github", owner: "acme", repo: "review" },
        scope: "project",
        enabled: true,
        targets: ["cursor"],
        installed_at: 100,
        updated_at: 100,
      }],
    })
    await writeExtensionLock(lockStatePath(stateRoot), {
      version: 1,
      packages: {
        review: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          manifest_digests: { package: "abc" },
          component_digests: { package: "abc" },
          targets: ["cursor"],
        },
      },
    })

    await expect(uninstallAgentExtension({
      id: "review",
      scope: "project",
      projectDir: project,
      dataRoot: data,
      now: 300,
    })).resolves.toMatchObject({
      package_name: "review",
      resolved_sha: "abcdef1234567890",
      enabled: false,
      status: "disabled",
    })

    await expect(fs.readFile(path.join(project, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      installs: [],
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "lock.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {},
    })
    await expect(fs.readFile(path.join(project, ".agent-extensions", "materialized.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {},
    })
  })
})
