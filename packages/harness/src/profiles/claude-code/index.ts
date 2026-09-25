import fs from "node:fs/promises"
import path from "node:path"
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk"
import type { PluginProjection } from "../../contract"

const SETTINGS = ["settings.json", "settings.local.json", "cowork_settings.json"] as const
const CREDENTIAL_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"]
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_)|(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)(_|$)/

export function claudePlugins(projection: PluginProjection): SdkPluginConfig[] {
  return [...new Set(projection.pluginRoots.map((root) => root.root))].map((pluginPath) => ({ type: "local", path: pluginPath }))
}

export function scrubClaudeSettings(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude settings must be an object")
  const values = Object.fromEntries(Object.entries(parsed).filter(([key]) => !CREDENTIAL_KEYS.includes(key)))
  if (values.env && (typeof values.env !== "object" || Array.isArray(values.env))) throw new Error("Claude settings env must be an object")
  if (!values.env) return values
  return { ...values, env: Object.fromEntries(Object.entries(values.env).filter(([name]) => !CREDENTIAL_ENV.test(name))) }
}

export async function composeClaudeConfigHome(root: string, source: string): Promise<string> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  for (const name of SETTINGS) {
    const from = path.join(source, name)
    const to = path.join(root, name)
    await fs.rm(to, { force: true })
    let content: string
    try { content = await fs.readFile(from, "utf8") }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    await fs.writeFile(to, JSON.stringify(scrubClaudeSettings(content)), { mode: 0o600 })
  }
  return root
}
