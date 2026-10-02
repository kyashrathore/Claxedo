import fs from "node:fs/promises"
import path from "node:path"
import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk"
import { readTextIfExists, writePrivateFileAtomic } from "@claxedo/helpers/fs"
import type { PluginProjection } from "../../contract"
import { mirrorConfigEntries } from "../config-mirror"

export const CLAUDE_SETTINGS_FILES = ["settings.json", "settings.local.json", "cowork_settings.json"] as const
const MIRRORED = ["CLAUDE.md", "memory", "agents", "commands", "skills", "plugins", "projects", "todos", "history.jsonl"] as const
const CLAUDE_WRITTEN = ["projects", "todos", "history.jsonl"] as const

export const CLAUDE_COMMAND_DENY_RULES = ["Bash(rm -rf /*)", "Bash(rm -rf ~*)", "Bash(git push --force*)", "Bash(curl *| sh)",
  "Bash(curl *| bash)", "Bash(wget *| sh)", "Bash(chmod -R 777*)"] as const

export function claudePermissionSettings(allow: string[], ask: string[], deny: string[]) {
  return { permissions: { allow, ask, deny: [...deny, ...CLAUDE_COMMAND_DENY_RULES] } }
}
const CREDENTIAL_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"]
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_)|(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)(_|$)/
const SECRET_FILE = /^(?:\.claude\.json|auth\.json)$|(?:^|[-_.])(?:credential|credentials|oauth|secret|token|password|keychain)(?:[-_.]|$)/i

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
  await mirrorConfigEntries(source, root, MIRRORED, {
    secretFile: SECRET_FILE, externalSkills: true, initialize: CLAUDE_WRITTEN, allowDisappeared: true, allowMissingRoot: true,
  })
  for (const name of CLAUDE_SETTINGS_FILES) {
    const to = path.join(root, name)
    const content = await readTextIfExists(path.join(source, name))
    if (content === undefined) await fs.rm(to, { force: true })
    else await writePrivateFileAtomic(to, JSON.stringify(scrubClaudeSettings(content)))
  }
  return root
}
