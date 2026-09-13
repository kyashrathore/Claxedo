import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { asRecord } from "@claxedo/helpers/guards"

/** The entries that carry a signed-in account rather than configuration. */
const ACCOUNT_ENTRIES = new Set([".claude.json", ".credentials.json"])

/**
 * Every settings file this config dir owns. Each is copied and scrubbed rather
 * than linked, because a link would carry the operator's own credential routes
 * into a brokered turn and a write through it would edit their file.
 *
 * `@anthropic-ai/claude-agent-sdk@0.3.220` reads `cowork_settings.json` from
 * the config dir in place of `settings.json` whenever the `coworkPlugins`
 * option or `CLAUDE_CODE_USE_COWORK_PLUGINS` is set, so it names a credential
 * by every route `settings.json` does.
 */
const SETTINGS_ENTRIES = ["settings.json", "settings.local.json", "cowork_settings.json"] as const

/**
 * Settings keys that hand the CLI a credential of its own. `apiKeyHelper` runs
 * a command whose output is sent as the key; the two AWS keys name commands
 * Bedrock auth is refreshed and exported through.
 */
const CREDENTIAL_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"] as const

/**
 * Environment names through which a settings file can name a credential.
 *
 * The two prefixes are Claude's own. The word list covers the vendor variables
 * a Bedrock or Vertex setup reaches the same account through, matched as a
 * whole underscore-separated word rather than a suffix — `AWS_BEARER_TOKEN_BEDROCK`
 * carries a credential and ends in neither `_KEY` nor `_TOKEN`.
 */
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_)|(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)(_|$)/

/**
 * The operator's settings with every route back to their own credential
 * removed. An `env` block is applied over the spawn environment, so a name left
 * in it reaches the vendor as the operator's account while the placeholder goes
 * unused. Unreadable or malformed settings mirror as an empty object rather
 * than failing the turn — the file is configuration, not the credential.
 */
export function brokeredClaudeSettings(content: string | undefined): Record<string, unknown> {
  const parsed = (() => {
    try {
      return content === undefined ? undefined : asRecord(JSON.parse(content))
    } catch {
      return undefined
    }
  })()
  if (!parsed) return {}
  const settings = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !CREDENTIAL_KEYS.some((named) => named === key)),
  )
  const env = asRecord(settings.env)
  if (!env) return settings
  return {
    ...settings,
    env: Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_ENV.test(name))),
  }
}

/**
 * A Claude Code config directory holding the operator's configuration and no
 * account.
 *
 * Claude Code 2.1.267 prefers the account configured in its config dir over
 * both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`: given one, it sends its
 * own OAuth bearer and the broker placeholder is never used. Withholding the
 * account is therefore what makes a projection reach the vendor at all.
 *
 * Everything except the settings files is mirrored as a symlink, so memory,
 * agents, commands, skills, plugins and the transcript directories stay the
 * operator's own. The settings files are copied and scrubbed instead: each can
 * name a credential the account entries no longer carry, and a link would put
 * a write by the turn into the operator's own file. `~/.claude.json` is not one
 * of these entries — Claude Code writes it inside the config dir, so a fresh
 * one appears here and the operator's stays untouched.
 *
 * The workspace's own `.claude/settings.json` and `.claude/settings.local.json`
 * are NOT covered: the SDK resolves both from the working directory and the
 * canonical git root, which this process must not rewrite, and no documented
 * way to redirect those paths was confirmed. A repository that names a
 * credential there still reaches the vendor on it.
 */
export function brokeredClaudeConfigDir(input: {
  root: string
  source?: string
} = { root: path.join(os.homedir(), ".claxedo", "claude", "config") }): string {
  const source = input.source ?? path.join(os.homedir(), ".claude")
  fs.mkdirSync(input.root, { recursive: true, mode: 0o700 })
  const present = fs.existsSync(source) ? fs.readdirSync(source) : []
  const mirrored = present.filter((name) =>
    !ACCOUNT_ENTRIES.has(name) && !SETTINGS_ENTRIES.some((entry) => entry === name))
  for (const name of mirrored) {
    const link = path.join(input.root, name)
    // Only a link this function owns is replaced. A real file or directory here
    // is Claude Code's own state for this config dir and must survive.
    if (fs.lstatSync(link, { throwIfNoEntry: false })) continue
    try {
      fs.symlinkSync(path.join(source, name), link)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
  }
  for (const entry of SETTINGS_ENTRIES) {
    const settingsFile = path.join(input.root, entry)
    // Rewritten on every launch: the operator edits their own settings between
    // turns, and a stale copy would silently pin the first version they had.
    fs.rmSync(settingsFile, { force: true })
    if (!present.includes(entry)) continue
    const content = (() => {
      try {
        return fs.readFileSync(path.join(source, entry), "utf8")
      } catch {
        return undefined
      }
    })()
    fs.writeFileSync(settingsFile, JSON.stringify(brokeredClaudeSettings(content), null, 2), { mode: 0o600 })
  }
  const kept = new Set(mirrored)
  for (const name of fs.readdirSync(input.root)) {
    const link = path.join(input.root, name)
    if (kept.has(name) || !fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue
    fs.rmSync(link)
  }
  return input.root
}
