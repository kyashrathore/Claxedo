import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { cachePackageRoot } from "./cache"
import { linkOrCopyOwnedDirectory, type MaterializedRuntimeRecord } from "./materialization"
import { uninstallOwnedComponents } from "./materialize"

const root = path.join(os.tmpdir(), `workspace-runtime-materialization-${randomUUID().slice(0, 8)}`)

describe("Agent Extension materialization ownership", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("repairs stale symlinks that point at the same generated cache package", async () => {
    const source = path.join(root, "worktree", ".agent-extensions", "cache", "abc", "skills", "pdf")
    const staleSource = path.join(root, "main", ".agent-extensions", "cache", "abc", "skills", "pdf")
    const target = path.join(root, "worktree", ".claude", "skills", "pdf")
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(staleSource, { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "current")
    await fs.writeFile(path.join(staleSource, "SKILL.md"), "stale")
    await fs.symlink(staleSource, target, "dir")

    await expect(linkOrCopyOwnedDirectory({
      sourceDir: source,
      targetDir: target,
      ownerId: "pdf",
      record: {
        version: 1,
        packages: {
          pdf: {
            package_name: "pdf",
            source: { type: "github", owner: "anthropics", repo: "skills", package_path: "skills/pdf" },
            resolved_sha: "abc",
            enabled: true,
            targets: ["claude"],
            components: [{
              runner: "claude",
              component: "pdf",
              type: "skill",
              status: "applied",
              path: path.join(root, "main", ".claude", "skills", "pdf"),
            }],
            materialized_at: 1,
            status: "applied",
          },
        },
      },
    })).resolves.toEqual({ status: "applied", path: target })

    await expect(fs.realpath(target)).resolves.toBe(await fs.realpath(source))
    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe("current")
  })

  test("keeps owned generated cache symlinks applied on idempotent replay", async () => {
    const source = path.join(root, "worktree", ".agent-extensions", "cache", "abc", "skills", "pdf")
    const target = path.join(root, "worktree", ".claude", "skills", "pdf")
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "current")
    await fs.symlink(source, target, "dir")

    await expect(linkOrCopyOwnedDirectory({
      sourceDir: source,
      targetDir: target,
      ownerId: "pdf",
      record: {
        version: 1,
        packages: {
          pdf: {
            package_name: "pdf",
            source: { type: "github", owner: "anthropics", repo: "skills", package_path: "skills/pdf" },
            resolved_sha: "abc",
            enabled: true,
            targets: ["claude"],
            components: [{
              runner: "claude",
              component: "pdf",
              type: "skill",
              status: "applied",
              path: target,
            }],
            materialized_at: 1,
            status: "applied",
          },
        },
      },
    })).resolves.toEqual({ status: "applied", path: target })
  })

  test("adopts stale symlinks that point at the same package in the data-root install cache", async () => {
    const source = cachePackageRoot({ resolvedSha: "abc1234", packagePath: "skills/pdf", dataRoot: path.join(root, "data") })
    const staleSource = cachePackageRoot({ resolvedSha: "abc1234", packagePath: "skills/pdf", dataRoot: path.join(root, "stale-data") })
    const target = path.join(root, "worktree", ".claude", "skills", "pdf")
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(staleSource, { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "current")
    await fs.writeFile(path.join(staleSource, "SKILL.md"), "stale")
    await fs.symlink(staleSource, target, "dir")

    await expect(linkOrCopyOwnedDirectory({
      sourceDir: source,
      targetDir: target,
      ownerId: "pdf",
    })).resolves.toEqual({ status: "applied", path: target })

    await expect(fs.realpath(target)).resolves.toBe(await fs.realpath(source))
    await expect(fs.readFile(path.join(target, "SKILL.md"), "utf8")).resolves.toBe("current")
  })

  test("still rejects symlinks that point at a different package in the data-root install cache", async () => {
    const source = cachePackageRoot({ resolvedSha: "abc1234", packagePath: "skills/pdf", dataRoot: path.join(root, "data") })
    const other = cachePackageRoot({ resolvedSha: "def5678", packagePath: "skills/pdf", dataRoot: path.join(root, "data") })
    const target = path.join(root, "worktree", ".claude", "skills", "pdf")
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(other, { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "current")
    await fs.writeFile(path.join(other, "SKILL.md"), "other")
    await fs.symlink(other, target, "dir")

    await expect(linkOrCopyOwnedDirectory({
      sourceDir: source,
      targetDir: target,
      ownerId: "pdf",
    })).rejects.toMatchObject({
      name: "AgentExtensionMaterializationError",
      code: "agent_extension_target_path_conflict",
    })

    await expect(fs.realpath(target)).resolves.toBe(await fs.realpath(other))
  })

  test("uninstallOwnedComponents removes MCP entries without deleting the shared config file", async () => {
    const mcpFile = path.join(root, "project", ".mcp.json")
    const skillDir = path.join(root, "project", ".cursor", "skills", "docs")
    await fs.mkdir(path.dirname(mcpFile), { recursive: true })
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "docs skill")
    await fs.writeFile(mcpFile, JSON.stringify({
      mcpServers: {
        docs: { type: "stdio", command: "node", args: [], env: {} },
        unrelated: { type: "stdio", command: "python", args: [], env: {} },
      },
    }, null, 2))
    const record: MaterializedRuntimeRecord = {
      version: 1,
      packages: {
        docs: {
          package_name: "docs",
          source: { type: "github", owner: "acme", repo: "docs" },
          resolved_sha: "abc",
          enabled: true,
          targets: ["claude", "cursor"],
          components: [
            { runner: "claude", component: "docs", type: "mcp", status: "applied", path: mcpFile },
            { runner: "cursor", component: "docs", type: "skill", status: "applied", path: skillDir },
          ],
          materialized_at: 1,
          status: "applied",
        },
      },
    }

    await uninstallOwnedComponents({ record, ownerId: "docs" })

    await expect(fs.stat(skillDir)).rejects.toThrow()
    const remaining = JSON.parse(await fs.readFile(mcpFile, "utf8")) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(remaining.mcpServers)).toEqual(["unrelated"])
  })

  test("still rejects unmanaged symlink collisions outside generated caches", async () => {
    const source = path.join(root, "worktree", ".agent-extensions", "cache", "abc", "skills", "pdf")
    const unmanaged = path.join(root, "unmanaged", "pdf")
    const target = path.join(root, "worktree", ".claude", "skills", "pdf")
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(unmanaged, { recursive: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "current")
    await fs.writeFile(path.join(unmanaged, "SKILL.md"), "local")
    await fs.symlink(unmanaged, target, "dir")

    await expect(linkOrCopyOwnedDirectory({
      sourceDir: source,
      targetDir: target,
      ownerId: "pdf",
    })).rejects.toMatchObject({
      name: "AgentExtensionMaterializationError",
      code: "agent_extension_target_path_conflict",
    })

    await expect(fs.realpath(target)).resolves.toBe(await fs.realpath(unmanaged))
  })
})
