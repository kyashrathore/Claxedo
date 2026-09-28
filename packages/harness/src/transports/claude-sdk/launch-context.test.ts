import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StartInput } from "../../contract"
import { claudeLaunchContext } from "./launch-context"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-home-keep-"))
  const source = path.join(root, "owner")
  await fs.mkdir(source)
  const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: root, locality: "local", owner: { kind: "machine-owner" },
    config: { harness: { id: "claude", access: "native" } }, projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
    credentials: { providers: { anthropic: { baseUrl: "http://127.0.0.1:48850", placeholder: "live-placeholder", authMode: "api-key", expiresAt: Date.now() + 60_000 } },
      secrets: {}, leaseGeneration: "g1" } }
  const options = { executable: "claude", configRoot: path.join(root, "homes"), userConfigRoot: source, env: {} }
  const launch = async () => {
    const context = await claudeLaunchContext(input, options, input.sessionId)
    return { ...context, env: context.env as Record<string, string> }
  }
  return { root, source, input, options, launch, close: () => fs.rm(root, { recursive: true, force: true }) }
}

test("a brokered Claude launch copies all settings files without account routes or unknown entries", async () => {
  const f = await fixture()
  try {
    const settings = { model: "opus", apiKeyHelper: "operator-sentinel", awsAuthRefresh: "operator-sentinel", awsCredentialExport: "operator-sentinel",
      env: { ANTHROPIC_API_KEY: "operator-sentinel", CLAUDE_CODE_USE_BEDROCK: "1", AWS_BEARER_TOKEN_BEDROCK: "operator-sentinel", VERTEX_API_KEY: "operator-sentinel", EDITOR: "vim" } }
    for (const name of ["settings.json", "settings.local.json", "cowork_settings.json"]) await fs.writeFile(path.join(f.source, name), JSON.stringify(settings))
    for (const name of [".claude.json", ".credentials.json", "oauth-account.json"]) await fs.writeFile(path.join(f.source, name), "operator-sentinel")
    await fs.mkdir(path.join(f.source, "sessions"))
    await fs.writeFile(path.join(f.source, "CLAUDE.md"), "instructions")
    const context = await f.launch()
    const home = context.env.CLAUDE_CONFIG_DIR!
    expect((await fs.readdir(home)).sort()).toEqual(["CLAUDE.md", "cowork_settings.json", "settings.json", "settings.local.json"])
    for (const name of ["settings.json", "settings.local.json", "cowork_settings.json"]) {
      expect((await fs.lstat(path.join(home, name))).isSymbolicLink()).toBe(false)
      expect(JSON.parse(await fs.readFile(path.join(home, name), "utf8"))).toEqual({ model: "opus", env: { EDITOR: "vim" } })
      expect(JSON.parse(await fs.readFile(path.join(f.source, name), "utf8"))).toEqual(settings)
    }
    expect(context.env.ANTHROPIC_API_KEY).toBe("live-placeholder")
    expect(context.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:48850")
  } finally { await f.close() }
})

test("the next Claude launch preserves CLI state removes stale mirrors and refreshes settings", async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.source, "CLAUDE.md"), "instructions")
    await fs.writeFile(path.join(f.source, "settings.json"), '{"model":"opus"}')
    const home = (await f.launch()).env.CLAUDE_CONFIG_DIR!
    await fs.writeFile(path.join(home, ".claude.json"), '{"projects":{}}')
    await fs.rm(path.join(f.source, "CLAUDE.md"))
    await fs.writeFile(path.join(f.source, "settings.json"), '{"model":"sonnet"}')
    expect((await f.launch()).env.CLAUDE_CONFIG_DIR).toBe(home)
    expect(await fs.readFile(path.join(home, ".claude.json"), "utf8")).toBe('{"projects":{}}')
    expect(await fs.readdir(home)).not.toContain("CLAUDE.md")
    expect(JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"))).toEqual({ model: "sonnet" })
  } finally { await f.close() }
})

test("unbinding Claude removes the broker home environment override on the next launch", async () => {
  const f = await fixture()
  try {
    expect((await f.launch()).env.CLAUDE_CONFIG_DIR).toBe(path.join(f.options.configRoot, "s1"))
    f.input.credentials = { providers: {}, secrets: {}, leaseGeneration: "g2" }
    const unbound = await f.launch()
    expect(unbound.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(unbound.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(unbound.env.ANTHROPIC_BASE_URL).toBeUndefined()
  } finally { await f.close() }
})
