import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "util"
import { digestDirectory } from "./cache"
import { applyRuntimeAgentExtensions } from "./replay"

const root = path.join(os.tmpdir(), `workspace-runtime-agent-extensions-${crypto.randomUUID().slice(0, 8)}`)
const execFile = promisify(nodeExecFile)

// Replay state is HOST-OWNED: with no explicit `stateRoot`, it lands under the
// caller's home (`<home>/.claxedo/agent-extensions`), never in the project
// tree. Every call below passes `homeDir: <root>/home`, so this is where their
// ledger/lock/cache go — and asserting through it is what proves the workspace
// at `root` stays clean.
const stateRoot = path.join(root, "home", ".claxedo", "agent-extensions")
const statePath = (...segments: string[]) => path.join(stateRoot, ...segments)

// A remote install may not be materialized unless its lock pins the package
// content, so fixtures build the package tree once, hash it, and hand the same
// writer to the git stub — what the stub produces is exactly what the lock
// pins. Building the tree twice (once to hash, once to serve) is the point:
// it is the same equality the runtime checks.
async function fixtureDigest(write: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(root, "fixture-"))
  await write(dir)
  const digest = await digestDirectory(dir)
  await fs.rm(dir, { recursive: true, force: true })
  return digest
}

describe("runtime Agent Extensions replay", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("writes desired, lock, and materialized replay files without generated paths", async () => {
    const writePackage = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "SKILL.md"), "skill")
    }
    const digest = await fixtureDigest(writePackage)
    const commands: Array<{ file: string; args: string[]; cwd?: string }> = []
    const tempRoots: string[] = []
    const execFile = async (_file: string, args: string[]) => {
      commands.push({ file: _file, args })
      if (args[0] === "init") {
        tempRoots.push(args[1]!)
        await fs.mkdir(args[1]!, { recursive: true })
        await writePackage(path.join(args[1]!, "packages", "review"))
      }
      return { stdout: "", stderr: "" }
    }

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review", package_path: "packages/review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: digest },
          targets: ["cursor"],
        },
        status: "applied",
        components: [{
          runner: "cursor",
          component: "review",
          type: "skill",
          status: "applied",
        }],
      }],
    }, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })

    await expect(fs.readFile(statePath("installed.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      installs: [{
        id: "review",
        package_name: "review",
        source: { type: "github", owner: "acme", repo: "review", package_path: "packages/review" },
        enabled: true,
        targets: ["cursor"],
      }],
    })
    await expect(fs.readFile(statePath("lock.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {
        review: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: digest },
          targets: ["cursor"],
        },
      },
    })
    await expect(fs.readFile(statePath("materialized.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      version: 1,
      packages: {
        review: {
          status: "applied",
          components: [{
            runner: "cursor",
            component: "review",
            type: "skill",
            status: "applied",
            path: path.join(root, ".cursor", "skills", "review"),
          }],
        },
      },
    })
    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("skill")
    expect(commands.map((item) => item.args.slice(0, 2))).toEqual([
      ["init", tempRoots[0]],
      ["remote", "add"],
      ["fetch", "--depth"],
      ["checkout", "--detach"],
    ])
    await expect(fs.stat(tempRoots[0]!)).rejects.toThrow()
  })

  test("materializes standalone MCP configs for Cursor and Codex", async () => {
    const writePackage = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({
        servers: {
          docs: { command: "node", args: ["server.js"], env: {} },
        },
      }))
    }
    const digest = await fixtureDigest(writePackage)
    const execFile = async (_file: string, args: string[]) => {
      if (args[0] === "init") await writePackage(args[1]!)
      return { stdout: "", stderr: "" }
    }

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "docs",
          package_name: "docs",
          source: { type: "github", owner: "acme", repo: "docs" },
          enabled: true,
          targets: ["cursor", "codex"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: digest },
          targets: ["cursor", "codex"],
        },
        components: [],
      }],
    }, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })

    await expect(fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      mcpServers: {
        docs: { command: "node", args: ["server.js"], env: {} },
      },
    })
    await expect(fs.readFile(path.join(root, ".codex", "config.toml"), "utf8")).resolves.toBe([
      "[mcp_servers.docs]",
      'command = "node"',
      'args = ["server.js"]',
      "",
    ].join("\n"))
    await expect(fs.readFile(statePath("materialized.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        docs: {
          status: "applied",
          components: [
            { runner: "cursor", component: "docs", type: "mcp", status: "applied" },
            { runner: "codex", component: "docs", type: "mcp", status: "applied" },
          ],
        },
      },
    })
  })

  test("materializes OpenCode skills and MCP config through replay", async () => {
    const skillRoot = path.join(root, "packages", "review")
    const mcpRoot = path.join(root, "packages", "docs")
    await fs.mkdir(skillRoot, { recursive: true })
    await fs.mkdir(mcpRoot, { recursive: true })
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n")
    await fs.writeFile(path.join(mcpRoot, "mcp.json"), JSON.stringify({
      servers: {
        docs: { command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
      },
    }))

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [
        {
          desired: {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            enabled: true,
            targets: ["opencode"],
          },
          lock: {
            resolved_sha: "abcdef1234567890",
            component_digests: { package: await digestDirectory(skillRoot) },
            targets: ["opencode"],
          },
          components: [],
        },
        {
          desired: {
            id: "docs",
            package_name: "docs",
            source: { type: "github", owner: "acme", repo: "docs" },
            enabled: true,
            targets: ["opencode"],
          },
          lock: {
            resolved_sha: "abcdef9999999999",
            component_digests: { package: await digestDirectory(mcpRoot) },
            targets: ["opencode"],
          },
          components: [],
        },
      ],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: {
        review: skillRoot,
        docs: mcpRoot,
      },
    })

    await expect(fs.readFile(path.join(root, ".opencode", "skills", "review", "SKILL.md"), "utf8")).resolves.toContain("name: review")
    await expect(fs.readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      mcp: {
        docs: {
          type: "local",
          command: ["node", "server.js"],
          enabled: true,
          environment: { TOKEN: "secret" },
        },
      },
    })
  })

  test("materializes multiple components from conventional package directories", async () => {
    const packageRoot = path.join(root, "packages", "toolkit")
    await fs.mkdir(path.join(packageRoot, "skills", "review"), { recursive: true })
    await fs.mkdir(path.join(packageRoot, "mcp"), { recursive: true })
    await fs.mkdir(path.join(packageRoot, "plugins", "cursor", "notes"), { recursive: true })
    await fs.writeFile(path.join(packageRoot, "skills", "review", "SKILL.md"), "review skill")
    await fs.writeFile(path.join(packageRoot, "mcp", "docs.json"), JSON.stringify({
      servers: {
        docs: { command: "node", args: ["server.js"] },
      },
    }))
    await fs.writeFile(path.join(packageRoot, "plugins", "cursor", "notes", "plugin.json"), JSON.stringify({ name: "notes" }))

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "toolkit",
          package_name: "toolkit",
          source: { type: "github", owner: "acme", repo: "toolkit" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: await digestDirectory(packageRoot) },
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { toolkit: packageRoot },
    })

    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      mcpServers: {
        docs: { command: "node", args: ["server.js"], env: {} },
      },
    })
    await expect(fs.readFile(path.join(root, "home", ".cursor", "plugins", "local", "notes", "plugin.json"), "utf8").then(JSON.parse)).resolves.toEqual({ name: "notes" })
    await expect(fs.readFile(statePath("materialized.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      packages: {
        toolkit: {
          status: "applied",
          components: [
            { runner: "cursor", component: "review", type: "skill", status: "applied" },
            { runner: "cursor", component: "docs", type: "mcp", status: "applied" },
            { runner: "cursor", component: "notes", type: "plugin", status: "applied" },
          ],
        },
      },
    })
  })

  test("materializes workspace Cursor plugins inside the workspace root", async () => {
    const packageRoot = path.join(root, "packages", "workspace-plugin")
    const homeDir = path.join(root, "home")
    await fs.mkdir(path.join(packageRoot, "plugins", "cursor", "notes"), { recursive: true })
    await fs.mkdir(path.join(homeDir, ".cursor", "plugins", "local", "notes"), { recursive: true })
    await fs.writeFile(path.join(packageRoot, "plugins", "cursor", "notes", "plugin.json"), JSON.stringify({ name: "notes" }))
    await fs.writeFile(path.join(homeDir, ".cursor", "plugins", "local", "notes", "plugin.json"), JSON.stringify({ name: "unmanaged" }))

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "workspace-plugin",
          package_name: "workspace-plugin",
          source: { type: "github", owner: "acme", repo: "workspace-plugin" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: await digestDirectory(packageRoot) },
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir,
      packageRoots: { "workspace-plugin": packageRoot },
    })

    await expect(fs.readFile(path.join(root, ".cursor", "plugins", "local", "notes", "plugin.json"), "utf8").then(JSON.parse)).resolves.toEqual({ name: "notes" })
    await expect(fs.readFile(path.join(homeDir, ".cursor", "plugins", "local", "notes", "plugin.json"), "utf8").then(JSON.parse)).resolves.toEqual({ name: "unmanaged" })
  })

  test("materializes first-party project extensions from the fixed agent-extensions directory", async () => {
    const packageRoot = path.join(root, "agent-extensions")
    await fs.mkdir(path.join(packageRoot, "skills", "review"), { recursive: true })
    await fs.writeFile(path.join(packageRoot, "skills", "review", "SKILL.md"), "review skill")

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "first-party-agent-extensions",
          package_name: "agent-extensions",
          source: { type: "project", package_path: "agent-extensions" },
          scope: "project",
          enabled: true,
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      execFile: async () => {
        throw new Error("project Agent Extensions should not fetch from Git")
      },
      tempRoot: root,
      homeDir: path.join(root, "home"),
    })

    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.readFile(statePath("installed.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      installs: [{
        id: "first-party-agent-extensions",
        package_name: "agent-extensions",
        source: { type: "project", package_path: "agent-extensions" },
        scope: "project",
        enabled: true,
        targets: ["cursor"],
      }],
    })
    await expect(fs.readFile(statePath("lock.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {},
    })
  })

  test("takes over a stale replay lock left by a crashed process", async () => {
    const packageRoot = path.join(root, "agent-extensions")
    await fs.mkdir(path.join(packageRoot, "skills", "review"), { recursive: true })
    await fs.writeFile(path.join(packageRoot, "skills", "review", "SKILL.md"), "review skill")
    const lock = statePath(".replay-lock")
    await fs.mkdir(lock, { recursive: true })
    const crashedAt = new Date(Date.now() - 11 * 60 * 1000)
    await fs.utimes(lock, crashedAt, crashedAt)

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "first-party-agent-extensions",
          package_name: "agent-extensions",
          source: { type: "project", package_path: "agent-extensions" },
          scope: "project",
          enabled: true,
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
    })

    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.stat(lock)).rejects.toThrow()
  })

  test("verifies lock digests before materializing runtime packages", async () => {
    const execFile = async (_file: string, args: string[]) => {
      if (args[0] === "init") {
        await fs.mkdir(args[1]!, { recursive: true })
        await fs.writeFile(path.join(args[1]!, "SKILL.md"), "review skill")
      }
      return { stdout: "", stderr: "" }
    }

    await expect(applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: "not-the-package-digest" },
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })).rejects.toThrow("Agent Extension review cache checksum mismatch")

    await expect(fs.stat(path.join(root, ".cursor", "skills", "review"))).rejects.toThrow()
  })

  test("refuses to materialize a runtime install whose lock records no package digest", async () => {
    const packageRoot = path.join(root, "packages", "review")
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "review skill")

    await expect(applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { review: packageRoot },
    })).rejects.toThrow("records no package digest")

    await expect(fs.stat(path.join(root, ".cursor", "skills", "review"))).rejects.toThrow()
  })

  test("refuses to materialize a runtime install that carries no lock at all", async () => {
    const packageRoot = path.join(root, "packages", "review")
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "review skill")

    await expect(applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { review: packageRoot },
    })).rejects.toThrow("no lock entry")

    await expect(fs.stat(path.join(root, ".cursor", "skills", "review"))).rejects.toThrow()
  })

  test("refuses to materialize when the pushed source disagrees with the locked source", async () => {
    const packageRoot = path.join(root, "packages", "review")
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "review skill")

    await expect(applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          // The snapshot claims a repo the lock never pinned. Changing the
          // pinned owner/repo/ref is a deliberate re-install, never something
          // a pushed snapshot gets to do implicitly.
          source: { type: "github", owner: "evil", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          component_digests: { package: await digestDirectory(packageRoot) },
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { review: packageRoot },
    })).rejects.toThrow("does not match its locked source")

    await expect(fs.stat(path.join(root, ".cursor", "skills", "review"))).rejects.toThrow()
  })

  test("refuses to re-materialize a package root that was tampered with after the first apply", async () => {
    const packageRoot = path.join(root, "packages", "review")
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "review skill")
    const snapshot = {
      version: 1 as const,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github" as const, owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          source: { type: "github" as const, owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          component_digests: { package: await digestDirectory(packageRoot) },
          targets: ["cursor"],
        },
        components: [],
      }],
    }
    const options = {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { review: packageRoot },
    }

    await applyRuntimeAgentExtensions(snapshot, root, { ...options, now: 100 })
    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")

    await fs.writeFile(path.join(packageRoot, "SKILL.md"), "attacker payload")

    await expect(applyRuntimeAgentExtensions(snapshot, root, { ...options, now: 200 }))
      .rejects.toThrow("cache checksum mismatch")
    // Nothing was rewritten: the ownership record still describes the first,
    // verified apply.
    await expect(fs.readFile(statePath("materialized.json"), "utf8").then(JSON.parse))
      .resolves.toMatchObject({ packages: { review: { materialized_at: 100 } } })
  })

  test("does not grant first-party Claxedo MCP env rewriting to a package whose lock does not pin that source", async () => {
    const packageRoot = path.join(root, "packages", "claxedo-mcp")
    await fs.mkdir(packageRoot, { recursive: true })
    await fs.writeFile(path.join(packageRoot, "mcp.json"), JSON.stringify({
      servers: {
        claxedo: { command: "node", args: ["server.js"], env: { CLAXEDO_SERVER_URL: "http://attacker.example" } },
      },
    }))
    const source = {
      type: "github" as const,
      owner: "kyashrathore",
      repo: "Claxedo",
      ref: "dev",
      package_path: "packages/claxedo-mcp",
    }

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "claxedo-mcp",
          package_name: "claxedo-mcp",
          source,
          enabled: true,
          targets: ["cursor"],
        },
        // Lock pins the content but records no source, so the snapshot's claim
        // to be the first-party package is unbacked and the package is
        // materialized verbatim like any third party.
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: await digestDirectory(packageRoot) },
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { "claxedo-mcp": packageRoot },
    })

    await expect(fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      mcpServers: {
        claxedo: { command: "node", args: ["server.js"], env: { CLAXEDO_SERVER_URL: "http://attacker.example" } },
      },
    })
  })

  test("fetches from git once and reuses the runtime cache on later applies", async () => {
    const repo = path.join(root, "source")
    const bare = path.join(root, "source.git")
    await fs.mkdir(path.join(repo, "packages", "review"), { recursive: true })
    await fs.writeFile(path.join(repo, "packages", "review", "SKILL.md"), "review skill")
    await execFile("git", ["init", "-b", "main"], { cwd: repo })
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo })
    await execFile("git", ["config", "user.name", "Test User"], { cwd: repo })
    await execFile("git", ["add", "."], { cwd: repo })
    await execFile("git", ["commit", "-m", "add review skill"], { cwd: repo })
    const sha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await execFile("git", ["clone", "--bare", repo, bare])

    const commands: string[][] = []
    const replayExecFile = async (file: string, args: string[], options?: { cwd?: string }) => {
      const rewritten = args[0] === "remote" && args[1] === "add"
        ? ["remote", "add", "origin", bare]
        : args
      commands.push(rewritten)
      return execFile(file, rewritten, options)
    }

    const snapshot = {
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github" as const, owner: "acme", repo: "review", package_path: "packages/review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: sha,
          component_digests: { package: await digestDirectory(path.join(repo, "packages", "review")) },
          targets: ["cursor"],
        },
        components: [],
      }],
    }

    await applyRuntimeAgentExtensions(snapshot, root, { execFile: replayExecFile, tempRoot: root, homeDir: path.join(root, "home") })
    await applyRuntimeAgentExtensions(snapshot, root, { execFile: replayExecFile, tempRoot: root, homeDir: path.join(root, "home") })

    expect(commands.filter((args) => args[0] === "fetch")).toHaveLength(1)
    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.stat(statePath("cache", sha, "packages", "review", "SKILL.md"))).resolves.toMatchObject({ size: 12 })
  })

  test("discards a corrupted runtime cache entry and refetches instead of failing forever", async () => {
    const repo = path.join(root, "source")
    const bare = path.join(root, "source.git")
    await fs.mkdir(path.join(repo, "packages", "review"), { recursive: true })
    await fs.writeFile(path.join(repo, "packages", "review", "SKILL.md"), "review skill")
    await execFile("git", ["init", "-b", "main"], { cwd: repo })
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo })
    await execFile("git", ["config", "user.name", "Test User"], { cwd: repo })
    await execFile("git", ["add", "."], { cwd: repo })
    await execFile("git", ["commit", "-m", "add review skill"], { cwd: repo })
    const sha = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim()
    await execFile("git", ["clone", "--bare", repo, bare])
    const digest = await digestDirectory(path.join(repo, "packages", "review"))

    // Simulate a crash mid-copy from an earlier replay: the cache path exists
    // but its content does not match the locked digest.
    const cached = statePath("cache", sha, "packages", "review")
    await fs.mkdir(cached, { recursive: true })
    await fs.writeFile(path.join(cached, "SKILL.md"), "partial copy")

    const replayExecFile = async (file: string, args: string[], options?: { cwd?: string }) => {
      const rewritten = args[0] === "remote" && args[1] === "add"
        ? ["remote", "add", "origin", bare]
        : args
      return execFile(file, rewritten, options)
    }

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github" as const, owner: "acme", repo: "review", package_path: "packages/review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: sha,
          component_digests: { package: digest },
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, { execFile: replayExecFile, tempRoot: root, homeDir: path.join(root, "home") })

    await expect(fs.readFile(path.join(cached, "SKILL.md"), "utf8")).resolves.toBe("review skill")
    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")
  })

  test("rejects runtime installs whose resolved SHA is not a hex commit id", async () => {
    await expect(applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github" as const, owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "--upload-pack=/tmp/evil",
          targets: ["cursor"],
        },
        components: [],
      }],
    }, root, {
      execFile: async () => {
        throw new Error("git must not run for an invalid SHA")
      },
      tempRoot: root,
      homeDir: path.join(root, "home"),
    })).rejects.toThrow("hex commit id")
  })

  test("replaces materialized skill trees instead of merging stale files", async () => {
    const firstRoot = path.join(root, "first")
    const secondRoot = path.join(root, "second")
    await fs.mkdir(path.join(firstRoot, "assets"), { recursive: true })
    await fs.mkdir(secondRoot, { recursive: true })
    await fs.writeFile(path.join(firstRoot, "SKILL.md"), "first skill")
    await fs.writeFile(path.join(firstRoot, "assets", "old.svg"), "old")
    await fs.writeFile(path.join(secondRoot, "SKILL.md"), "second skill")

    const install = (sha: string, digest: string) => ({
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github" as const, owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: sha,
          component_digests: { package: digest },
          targets: ["cursor"],
        },
        components: [],
      }],
    })

    await applyRuntimeAgentExtensions(install("abcdef1234567890", await digestDirectory(firstRoot)), root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { review: firstRoot },
    })
    await applyRuntimeAgentExtensions(install("abcdef9999999999", await digestDirectory(secondRoot)), root, {
      tempRoot: root,
      homeDir: path.join(root, "home"),
      packageRoots: { review: secondRoot },
    })

    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("second skill")
    await expect(fs.stat(path.join(root, ".cursor", "skills", "review", "assets", "old.svg"))).rejects.toThrow()
  })

  test("removes previously materialized owned artifacts when runtime replay disables an install", async () => {
    const writePackage = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "SKILL.md"), "review skill")
    }
    const digest = await fixtureDigest(writePackage)
    const execFile = async (_file: string, args: string[]) => {
      if (args[0] === "init") await writePackage(args[1]!)
      return { stdout: "", stderr: "" }
    }

    const enabled = {
      version: 1,
      installs: [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github" as const, owner: "acme", repo: "review" },
          enabled: true,
          targets: ["cursor"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: digest },
          targets: ["cursor"],
        },
        components: [],
      }],
    }

    await applyRuntimeAgentExtensions(enabled, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })
    await expect(fs.readFile(path.join(root, ".cursor", "skills", "review", "SKILL.md"), "utf8")).resolves.toBe("review skill")

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        ...enabled.installs[0],
        desired: {
          ...enabled.installs[0]!.desired,
          enabled: false,
        },
      }],
    }, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })

    await expect(fs.stat(path.join(root, ".cursor", "skills", "review"))).rejects.toThrow()
    await expect(fs.readFile(statePath("materialized.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      version: 1,
      packages: {
        review: {
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          enabled: false,
          targets: ["cursor"],
          components: [],
          materialized_at: expect.any(Number),
          status: "disabled",
        },
      },
    })
  })

  test("removes disabled runtime MCP entries without deleting unmanaged config", async () => {
    const writePackage = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({
        servers: {
          docs: { command: "node", args: ["docs.js"], env: {} },
        },
      }))
    }
    const digest = await fixtureDigest(writePackage)
    const execFile = async (_file: string, args: string[]) => {
      if (args[0] === "init") await writePackage(args[1]!)
      return { stdout: "", stderr: "" }
    }
    const enabled = {
      version: 1,
      installs: [{
        desired: {
          id: "docs",
          package_name: "docs",
          source: { type: "github" as const, owner: "acme", repo: "docs" },
          enabled: true,
          targets: ["cursor", "codex"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: digest },
          targets: ["cursor", "codex"],
        },
        components: [],
      }],
    }

    await applyRuntimeAgentExtensions(enabled, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })
    await fs.writeFile(path.join(root, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: {
        docs: { command: "node", args: ["docs.js"], env: {} },
        unmanaged: { command: "node", args: ["local.js"], env: {} },
      },
    }, null, 2))
    await fs.appendFile(path.join(root, ".codex", "config.toml"), [
      "",
      "[mcp_servers.unmanaged]",
      'command = "node"',
      'args = ["local.js"]',
      "",
    ].join("\n"))

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        ...enabled.installs[0],
        desired: {
          ...enabled.installs[0]!.desired,
          enabled: false,
        },
      }],
    }, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })

    await expect(fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      mcpServers: {
        unmanaged: { command: "node", args: ["local.js"], env: {} },
      },
    })
    await expect(fs.readFile(path.join(root, ".codex", "config.toml"), "utf8")).resolves.toBe([
      "[mcp_servers.unmanaged]",
      'command = "node"',
      'args = ["local.js"]',
      "",
    ].join("\n"))
  })

  test("removes disabled OpenCode runtime MCP entries without deleting unmanaged config", async () => {
    const writePackage = async (dir: string) => {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({
        servers: {
          docs: { command: "node", args: ["docs.js"], env: {} },
        },
      }))
    }
    const digest = await fixtureDigest(writePackage)
    const execFile = async (_file: string, args: string[]) => {
      if (args[0] === "init") await writePackage(args[1]!)
      return { stdout: "", stderr: "" }
    }
    const enabled = {
      version: 1,
      installs: [{
        desired: {
          id: "docs",
          package_name: "docs",
          source: { type: "github" as const, owner: "acme", repo: "docs" },
          enabled: true,
          targets: ["opencode"],
        },
        lock: {
          resolved_sha: "abcdef1234567890",
          component_digests: { package: digest },
          targets: ["opencode"],
        },
        components: [],
      }],
    }

    await applyRuntimeAgentExtensions(enabled, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })
    await fs.writeFile(path.join(root, ".opencode", "opencode.jsonc"), JSON.stringify({
      permission: { edit: "ask" },
      mcp: {
        docs: { type: "local", command: ["node", "docs.js"], enabled: true },
        unmanaged: { type: "remote", url: "https://mcp.example.test", enabled: true },
      },
    }, null, 2))

    await applyRuntimeAgentExtensions({
      version: 1,
      installs: [{
        ...enabled.installs[0],
        desired: {
          ...enabled.installs[0]!.desired,
          enabled: false,
        },
      }],
    }, root, { execFile, tempRoot: root, homeDir: path.join(root, "home") })

    await expect(fs.readFile(path.join(root, ".opencode", "opencode.jsonc"), "utf8").then(JSON.parse)).resolves.toEqual({
      permission: { edit: "ask" },
      mcp: {
        unmanaged: { type: "remote", url: "https://mcp.example.test", enabled: true },
      },
    })
  })
})
