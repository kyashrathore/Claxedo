import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"

export async function pluginFlowStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  console.log(`H15 waiting: ${label}`)
  try { return await operation() }
  catch (cause) { throw new Error(`H15 waiting for ${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }) }
}

export async function sharedCodexProfileConfig(dataDir: string): Promise<string> {
  const homes = path.join(dataDir, ".claxedo", "harness", "codex", "homes")
  const stores = (await fs.readdir(homes)).filter((name) => name.startsWith("codex-owner-")).map((name) => path.join(homes, name, "homes"))
  const profiles = (await Promise.all(stores.map(async (store) => (await fs.readdir(store)).map((name) => path.join(store, name))))).flat()
  const installed = await Promise.all(profiles.map((home) => fs.stat(path.join(home, "marketplace", "plugins", "e2e-proof")).then(() => home, () => undefined)))
  const pluginProfiles = await Promise.all(installed.flatMap((home) => home ? [fs.readFile(path.join(home, "config.toml"), "utf8")] : []))
  assert.equal(pluginProfiles.length, 1, `Expected one shared Codex plugin profile in ${homes}`)
  assert.match(pluginProfiles[0], /# BEGIN CLAXEDO CODEX PROFILE/)
  assert.match(pluginProfiles[0], /\[marketplaces.claxedo-agent-plugins\]/)
  return pluginProfiles[0]
}
