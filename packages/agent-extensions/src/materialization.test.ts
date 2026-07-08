import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { linkOrCopyOwnedDirectory } from "./materialization"

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
