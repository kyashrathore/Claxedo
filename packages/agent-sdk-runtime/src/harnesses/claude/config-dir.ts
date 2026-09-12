import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The entries that carry a signed-in account rather than configuration. */
const ACCOUNT_ENTRIES = new Set([".claude.json", ".credentials.json"])

/**
 * A Claude Code config directory holding the operator's configuration and no
 * account.
 *
 * Claude Code 2.1.267 prefers the account configured in its config dir over
 * both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`: given one, it sends its
 * own OAuth bearer and the broker placeholder is never used. Withholding the
 * account is therefore what makes a projection reach the vendor at all.
 *
 * Everything else is mirrored as a symlink, so settings, memory, agents,
 * commands, skills, plugins and the transcript directories stay the operator's
 * own. `~/.claude.json` is not one of those entries — Claude Code writes it
 * inside the config dir, so a fresh one appears here and the operator's stays
 * untouched.
 */
export function brokeredClaudeConfigDir(input: {
  root: string
  source?: string
} = { root: path.join(os.homedir(), ".claxedo", "claude", "config") }): string {
  const source = input.source ?? path.join(os.homedir(), ".claude")
  fs.mkdirSync(input.root, { recursive: true, mode: 0o700 })
  const mirrored = fs.existsSync(source)
    ? fs.readdirSync(source).filter((name) => !ACCOUNT_ENTRIES.has(name))
    : []
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
  const kept = new Set(mirrored)
  for (const name of fs.readdirSync(input.root)) {
    const link = path.join(input.root, name)
    if (kept.has(name) || !fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue
    fs.rmSync(link)
  }
  return input.root
}
