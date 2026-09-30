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
  const profiles = (await fs.readdir(homes)).filter((name) => name.startsWith("codex-"))
  const installed = await Promise.all(profiles.map((name) => fs.stat(path.join(homes, name, "marketplace", "plugins", "e2e-proof")).then(() => name, () => undefined)))
  const pluginProfiles = await Promise.all(installed.flatMap((name) => name ? [fs.readFile(path.join(homes, name, "config.toml"), "utf8")] : []))
  assert.equal(pluginProfiles.length, 1, `Expected one shared Codex plugin profile in ${homes}`)
  assert.match(pluginProfiles[0], /# BEGIN CLAXEDO CODEX PROFILE/)
  assert.match(pluginProfiles[0], /\[marketplaces.claxedo-agent-plugins\]/)
  return pluginProfiles[0]
}
