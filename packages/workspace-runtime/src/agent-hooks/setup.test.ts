import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { userHomeDir } from "@claxedo/helpers/path"
import { workspaceRuntimeDataDir } from "../env"
import { agentHookConfigPaths } from "./materialize-status-hooks"
import { setupAgentHooks } from "./setup"

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function fingerprint(homeDir: string) {
  return Object.fromEntries(Object.entries(agentHookConfigPaths(homeDir)).map(([runner, file]) => {
    if (!fs.existsSync(file)) return [runner, undefined]
    return [runner, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]
  }))
}

/** The home this process was launched with: Bun 1.3 reports the startup HOME here, not one the preload assigns. */
const accountHome = os.userInfo().homedir

test("agent hook setup writes every harness config under the test home and none under the account home", async () => {
  const home = userHomeDir()
  expect(contains(fs.realpathSync(os.tmpdir()), home)).toBe(true)
  expect(contains(accountHome, home)).toBe(false)
  expect(contains(home, workspaceRuntimeDataDir())).toBe(true)
  const before = fingerprint(accountHome)

  await setupAgentHooks({ port: 7860 })

  const written = agentHookConfigPaths(home)
  for (const file of Object.values(written)) expect({ file, exists: fs.existsSync(file) }).toEqual({ file, exists: true })
  expect(fingerprint(accountHome)).toEqual(before)
})

function tree(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {}
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, encoding: "utf8" }).sort().map((name) => {
    const file = path.join(root, name)
    return [name, fs.statSync(file).isDirectory() ? "dir" : createHash("sha256").update(fs.readFileSync(file)).digest("hex")]
  }))
}

test("agent hook setup leaves the person's Claude and Codex folders byte-identical and merges only its own Cursor entries", async () => {
  const home = userHomeDir()
  const seeded = {
    ".claude/settings.json": '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/user/stop.sh"}]}]}}\n',
    ".codex/hooks.json": '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/user/stop.sh"}]}]}}\n',
    ".codex/config.toml": 'model = "gpt-5.5"\n',
    ".cursor/hooks.json": '{"version":1,"hooks":{"stop":[{"command":"/user/stop.sh"}]}}\n',
  }
  for (const [name, content] of Object.entries(seeded)) {
    fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true })
    fs.writeFileSync(path.join(home, name), content)
  }
  const folders = [".claude", ".codex"].map((name) => path.join(home, name))
  const before = folders.map(tree)

  await setupAgentHooks({ port: 7860, force: true })

  expect(folders.map(tree)).toEqual(before)
  const cursorHooks = path.join(home, ".cursor", "hooks.json")
  const merged = fs.readFileSync(cursorHooks, "utf8")
  expect(merged.startsWith('{"version":1,"hooks":{"stop":[{"command":"/user/stop.sh"}')).toBe(true)
  expect(JSON.parse(merged).hooks.stop).toEqual([
    { command: "/user/stop.sh" },
    { command: `${path.join(workspaceRuntimeDataDir(), "hooks", "cursor-hook.sh")} Stop` },
  ])
  await setupAgentHooks({ port: 7860, force: true })
  expect(fs.readFileSync(cursorHooks, "utf8")).toBe(merged)
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(workspaceRuntimeDataDir(), "hooks", "claude-settings.json"), "utf8"))
  expect(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(path.join(workspaceRuntimeDataDir(), "hooks", "notify.sh"))
  expect(fs.readFileSync(path.join(workspaceRuntimeDataDir(), "bin", "codex"), "utf8")).toContain("--dangerously-bypass-hook-trust")
})
