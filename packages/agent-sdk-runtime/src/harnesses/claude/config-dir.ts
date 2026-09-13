import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { asRecord } from "@claxedo/helpers/guards"

/** The entries that carry a signed-in account rather than configuration. */
const ACCOUNT_ENTRIES = new Set([".claude.json", ".credentials.json"])

const SETTINGS_ENTRY = "settings.json"

/** Environment names through which a settings file can name a credential of its own. */
const CREDENTIAL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_)/

/**
 * The operator's settings with every route back to their own credential
 * removed: `apiKeyHelper` runs a command whose output the CLI sends as the key,
 * and an `env` block is applied over the spawn environment, so either one
 * reaches the vendor as the operator's account while the placeholder goes
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
  const { apiKeyHelper: _apiKeyHelper, ...settings } = parsed
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
 * Everything except `settings.json` is mirrored as a symlink, so memory, agents,
 * commands, skills, plugins and the transcript directories stay the operator's
 * own. `settings.json` is copied instead, scrubbed, because it can name a
 * credential the account entries no longer carry. `~/.claude.json` is not one of
 * these entries — Claude Code writes it inside the config dir, so a fresh one
 * appears here and the operator's stays untouched.
 */
export function brokeredClaudeConfigDir(input: {
  root: string
  source?: string
} = { root: path.join(os.homedir(), ".claxedo", "claude", "config") }): string {
  const source = input.source ?? path.join(os.homedir(), ".claude")
  fs.mkdirSync(input.root, { recursive: true, mode: 0o700 })
  const present = fs.existsSync(source) ? fs.readdirSync(source) : []
  const mirrored = present.filter((name) => !ACCOUNT_ENTRIES.has(name) && name !== SETTINGS_ENTRY)
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
  const settingsFile = path.join(input.root, SETTINGS_ENTRY)
  if (present.includes(SETTINGS_ENTRY)) {
    // Rewritten on every launch: the operator edits their own settings between
    // turns, and a stale copy would silently pin the first version they had.
    const content = (() => {
      try {
        return fs.readFileSync(path.join(source, SETTINGS_ENTRY), "utf8")
      } catch {
        return undefined
      }
    })()
    fs.rmSync(settingsFile, { force: true })
    fs.writeFileSync(settingsFile, JSON.stringify(brokeredClaudeSettings(content), null, 2), { mode: 0o600 })
  } else {
    fs.rmSync(settingsFile, { force: true })
  }
  const kept = new Set(mirrored)
  for (const name of fs.readdirSync(input.root)) {
    const link = path.join(input.root, name)
    if (kept.has(name) || !fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue
    fs.rmSync(link)
  }
  return input.root
}
