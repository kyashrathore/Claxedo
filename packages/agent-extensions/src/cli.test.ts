import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { runAgentExtensionsCli } from "./cli"

const root = path.join(os.tmpdir(), `agent-extensions-cli-${crypto.randomUUID().slice(0, 8)}`)

async function writeProjectSkill(project: string) {
  await fs.mkdir(path.join(project, "agent-extensions", "skills", "review"), { recursive: true })
  await fs.writeFile(path.join(project, "agent-extensions", "skills", "review", "SKILL.md"), "review skill")
}

describe("agent-extensions CLI", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("materializes first-party project extensions", async () => {
    await writeProjectSkill(root)
    const out: string[] = []
    const err: string[] = []

    await expect(runAgentExtensionsCli([
      "materialize",
      "--project",
      root,
      "--home",
      path.join(root, "home"),
      "--targets",
      "cursor",
    ], {
      cwd: root,
      now: 100,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    })).resolves.toBe(0)

    expect(err).toEqual([])
    expect(out.join("\n")).toContain("Materialized 1 first-party component(s)")
    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.readFile(path.join(root, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{
        id: "first-party-agent-extensions",
        source: { type: "project", package_path: "agent-extensions" },
        targets: ["cursor"],
      }],
    })
  })

  test("lists discovered and materialized first-party components", async () => {
    await writeProjectSkill(root)
    const out: string[] = []
    await runAgentExtensionsCli([
      "materialize",
      "--project",
      root,
      "--home",
      path.join(root, "home"),
      "--targets",
      "cursor",
    ], {
      cwd: root,
      stdout: () => {},
      stderr: () => {},
    })

    await expect(runAgentExtensionsCli(["list", "--project", root], {
      cwd: root,
      stdout: (text) => out.push(text),
      stderr: () => {},
    })).resolves.toBe(0)

    expect(out.join("\n")).toContain("skill:review")
    expect(out.join("\n")).toContain("first-party-agent-extensions: applied")
  })

  test("materialize and list honor a custom runtime dir", async () => {
    await writeProjectSkill(root)
    const runtimeDir = path.join(root, "custom-runtime")
    const out: string[] = []
    const jsonOut: string[] = []

    await expect(runAgentExtensionsCli([
      "materialize",
      "--project",
      root,
      "--home",
      path.join(root, "home"),
      "--runtime-dir",
      runtimeDir,
      "--targets",
      "cursor",
    ], {
      cwd: root,
      now: 100,
      stdout: () => {},
      stderr: () => {},
    })).resolves.toBe(0)

    await expect(fs.readFile(path.join(runtimeDir, "installed.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      installs: [{ id: "first-party-agent-extensions" }],
    })
    await expect(fs.stat(path.join(root, ".agent-extensions", "installed.json"))).rejects.toThrow()

    await expect(runAgentExtensionsCli([
      "list",
      "--project",
      root,
      "--runtime-dir",
      runtimeDir,
    ], {
      cwd: root,
      stdout: (text) => out.push(text),
      stderr: () => {},
    })).resolves.toBe(0)

    expect(out.join("\n")).toContain("first-party-agent-extensions: applied")

    await expect(runAgentExtensionsCli([
      "list",
      "--project",
      root,
      "--runtime-dir",
      runtimeDir,
      "--json",
    ], {
      cwd: root,
      stdout: (text) => jsonOut.push(text),
      stderr: () => {},
    })).resolves.toBe(0)

    expect(JSON.parse(jsonOut.join("\n"))).toMatchObject({
      materialized: {
        packages: {
          "first-party-agent-extensions": { status: "applied" },
        },
      },
    })
  })

  test("rejects runtime flags on lifecycle commands and cache flags on runtime commands", async () => {
    const err: string[] = []

    await expect(runAgentExtensionsCli([
      "install",
      "--runtime-dir",
      path.join(root, "runtime"),
      "--path",
      "packages/review",
    ], {
      cwd: root,
      stdout: () => {},
      stderr: (text) => err.push(text),
    })).resolves.toBe(1)
    expect(err.pop()).toBe("install uses --cache-dir, not --runtime-dir")

    await expect(runAgentExtensionsCli([
      "list",
      "--cache-dir",
      path.join(root, "cache"),
    ], {
      cwd: root,
      stdout: () => {},
      stderr: (text) => err.push(text),
    })).resolves.toBe(1)
    expect(err.pop()).toBe("list uses --runtime-dir, not --cache-dir")
  })

  test("does not keep old root flag aliases", async () => {
    const err: string[] = []

    await expect(runAgentExtensionsCli(["list", "--state-root", root], {
      cwd: root,
      stdout: () => {},
      stderr: (text) => err.push(text),
    })).resolves.toBe(1)
    expect(err.pop()).toBe("Unknown option: --state-root")

    await expect(runAgentExtensionsCli(["doctor", "--data-root", root], {
      cwd: root,
      stdout: () => {},
      stderr: (text) => err.push(text),
    })).resolves.toBe(1)
    expect(err.pop()).toBe("Unknown option: --data-root")
  })

  test("fails clearly when no first-party extension source exists", async () => {
    const err: string[] = []

    await expect(runAgentExtensionsCli(["materialize", "--project", root], {
      cwd: root,
      stdout: () => {},
      stderr: (text) => err.push(text),
    })).resolves.toBe(1)

    expect(err).toEqual(["No Agent Extension components found in agent-extensions"])
  })

  test("installs, disables, enables, and uninstalls a local package path", async () => {
    const source = path.join(root, "packages", "review")
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review\n---\n")
    const home = path.join(root, "home")

    await expect(runAgentExtensionsCli([
      "install",
      "--project",
      root,
      "--home",
      home,
      "--cache-dir",
      path.join(root, "data"),
      "--path",
      "packages/review",
      "--id",
      "review",
      "--targets",
      "cursor",
      "--json",
    ], {
      cwd: root,
      now: 100,
      stdout: () => {},
      stderr: () => {},
    })).resolves.toBe(0)

    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toContain("name: review")
    await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: review-updated\n---\n")

    await expect(runAgentExtensionsCli([
      "update",
      "review",
      "--project",
      root,
      "--home",
      home,
      "--cache-dir",
      path.join(root, "data"),
    ], {
      cwd: root,
      now: 200,
      stdout: () => {},
      stderr: () => {},
    })).resolves.toBe(0)

    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toContain("review-updated")

    for (const command of ["disable", "enable", "uninstall"]) {
      await expect(runAgentExtensionsCli([
        command,
        "review",
        "--project",
        root,
        "--home",
        home,
        "--cache-dir",
        path.join(root, "data"),
      ], {
        cwd: root,
        stdout: () => {},
        stderr: () => {},
      })).resolves.toBe(0)
    }

    await expect(fs.readFile(path.join(root, ".agent-extensions", "installed.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      installs: [],
    })
  })

  test("doctor reports broken state as JSON", async () => {
    await fs.mkdir(path.join(root, ".agent-extensions"), { recursive: true })
    await fs.writeFile(path.join(root, ".agent-extensions", "installed.json"), JSON.stringify({
      version: 1,
      installs: [{
        id: "review",
        package_name: "review",
        source: { type: "github", owner: "acme", repo: "review" },
        scope: "project",
        enabled: true,
        targets: ["cursor"],
        installed_at: 1,
        updated_at: 1,
      }],
    }))
    const out: string[] = []

    await expect(runAgentExtensionsCli([
      "doctor",
      "--project",
      root,
      "--cache-dir",
      path.join(root, "data"),
      "--json",
    ], {
      cwd: root,
      stdout: (text) => out.push(text),
      stderr: () => {},
    })).resolves.toBe(1)

    expect(JSON.parse(out.join("\n"))).toMatchObject({
      ok: false,
      issues: [{ code: "missing_lock", id: "review" }],
    })
  })
})
