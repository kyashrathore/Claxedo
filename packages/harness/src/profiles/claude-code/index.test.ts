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
