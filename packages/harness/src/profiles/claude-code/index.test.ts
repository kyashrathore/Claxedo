import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { claudePlugins, composeClaudeConfigHome, scrubClaudeSettings } from "./index"

test("plugin roots reach the SDK as distinct local folders", () => {
  expect(claudePlugins({ generation: "g1", mcpServers: [], notApplied: [], pluginRoots: [
    { pluginInstanceId: "one", root: "/plugin", dataRoot: "/data" },
    { pluginInstanceId: "two", root: "/plugin", dataRoot: "/data" },
  ] })).toEqual([{ type: "local", path: "/plugin" }])
})

test("a composed home copies safe settings and leaves the person's files untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-profile-test-"))
  const source = path.join(root, "person")
  const target = path.join(root, "claxedo")
  try {
    await fs.mkdir(source)
    const settings = JSON.stringify({ apiKeyHelper: "secret-command", awsAuthRefresh: "secret-command",
      env: { ANTHROPIC_API_KEY: "secret", AWS_BEARER_TOKEN_BEDROCK: "secret", PATH: "/bin" }, theme: "dark" })
    await fs.writeFile(path.join(source, "settings.json"), settings)
    await fs.writeFile(path.join(source, ".credentials.json"), "account-secret")
    await fs.writeFile(path.join(source, "future-account.json"), "account-secret")
    await composeClaudeConfigHome(target, source)
    expect(await fs.readFile(path.join(source, "settings.json"), "utf8")).toBe(settings)
    expect(JSON.parse(await fs.readFile(path.join(target, "settings.json"), "utf8"))).toEqual({ env: { PATH: "/bin" }, theme: "dark" })
    expect(await fs.readdir(target)).toEqual(["settings.json"])
    await fs.rm(path.join(source, "settings.json"))
    await composeClaudeConfigHome(target, source)
    expect(await fs.readdir(target)).toEqual([])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("malformed settings fail instead of carrying an unexamined credential route", () => {
  expect(() => scrubClaudeSettings("not json")).toThrow()
})

test("the composed home refreshes named configuration without writing to the person", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-mirror-test-"))
  const source = path.join(root, "person")
  const target = path.join(root, "claxedo")
  try {
    await fs.mkdir(path.join(source, "skills", "one"), { recursive: true })
    await fs.mkdir(path.join(source, "plugins", "installed"), { recursive: true })
    await fs.writeFile(path.join(source, "CLAUDE.md"), "first")
    await fs.writeFile(path.join(source, "skills", "one", "SKILL.md"), "skill")
    await fs.writeFile(path.join(source, "plugins", "installed", "plugin.json"), "{}")
    await composeClaudeConfigHome(target, source)
    expect(await fs.readFile(path.join(target, "skills", "one", "SKILL.md"), "utf8")).toBe("skill")
    expect(await fs.readFile(path.join(target, "plugins", "installed", "plugin.json"), "utf8")).toBe("{}")
    await fs.writeFile(path.join(target, ".claude.json"), "cli state")
    await fs.writeFile(path.join(source, "CLAUDE.md"), "second")
    await fs.rm(path.join(source, "skills"), { recursive: true })
    await composeClaudeConfigHome(target, source)
    expect(await fs.readFile(path.join(target, "CLAUDE.md"), "utf8")).toBe("second")
    expect(await fs.readdir(target)).toContain(".claude.json")
    expect(await fs.readdir(target)).not.toContain("skills")
    expect(await fs.readFile(path.join(source, "CLAUDE.md"), "utf8")).toBe("second")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test("internal plugin links are copied and links out of Claude home are refused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-links-test-"))
  const source = path.join(root, "person")
  const target = path.join(root, "claxedo")
  try {
    await fs.mkdir(path.join(source, "plugins", "cache"), { recursive: true })
    await fs.writeFile(path.join(source, "plugins", "cache", "plugin.json"), "{}")
    await fs.symlink("cache", path.join(source, "plugins", "installed"))
    await fs.mkdir(path.join(source, "skills"))
    await fs.mkdir(path.join(root, "external-skill"))
    await fs.writeFile(path.join(root, "external-skill", "SKILL.md"), "skill")
    await fs.symlink(path.join(root, "external-skill"), path.join(source, "skills", "linked"))
    await composeClaudeConfigHome(target, source)
    expect(await fs.readFile(path.join(target, "plugins", "installed", "plugin.json"), "utf8")).toBe("{}")
    expect(await fs.readFile(path.join(target, "skills", "linked", "SKILL.md"), "utf8")).toBe("skill")
    expect((await fs.lstat(path.join(target, "plugins", "installed"))).isSymbolicLink()).toBe(false)
    await fs.symlink(path.join(root, "outside"), path.join(source, "plugins", "foreign"))
    await fs.writeFile(path.join(root, "outside"), "account")
    await expect(composeClaudeConfigHome(target, source)).rejects.toThrow("link escapes")
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
