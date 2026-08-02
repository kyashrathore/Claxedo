import fs from "fs"
import os from "os"
import path from "path"
import { Log } from "../log"

const log = Log.create({ service: "credentials-codex-auth-file" })

/**
 * Keep the on-disk Codex login in step with a credential Claxedo just renewed.
 *
 * OpenAI may rotate the refresh token on every `grant_type=refresh_token`. When
 * Claxedo renews an *imported* login it would otherwise hold the new pair while
 * `~/.codex` keeps the superseded one, and the user's `codex` CLI could be left
 * holding a token the provider no longer honours. The Codex harness driver
 * already writes back for exactly this reason
 * (`agent-sdk-runtime/src/harnesses/codex/driver.ts`); this is the same contract
 * for the credential-verification path.
 *
 * Deliberately conservative: only files that already exist are touched, only
 * when their `tokens.account_id` matches the credential being renewed, and any
 * failure is logged rather than raised — a token mirror must never turn a
 * successful verification into an error.
 */

const mirroredProviders = ["codex-acp", "codex-app-server"]

type JsonRecord = Record<string, unknown>

export type RenewedCodexTokens = {
  accountId: string
  access: string
  refresh: string
  idToken?: string
}

export function shouldMirrorCodexTokens(credential: { provider_id: string; kind: string; source: string }) {
  // `local_only` is the marker for a login imported from this machine. A
  // `managed` credential was created inside Claxedo and owns no file on disk.
  return mirroredProviders.includes(credential.provider_id) &&
    credential.kind === "oauth_token" &&
    credential.source === "local_only"
}

/** Pull the renewed material out of a stored secret, if it is complete. */
export function renewedCodexTokens(secret: string, accountId: string | undefined | null): RenewedCodexTokens | undefined {
  if (!accountId) return
  const value = jsonRecord(secret)
  if (!value) return
  const tokens = record(value.tokens)
  const oauth = record(value.oauth)
  const access = text(value.access) ?? text(tokens?.access_token) ?? text(oauth?.access)
  const refresh = text(value.refresh) ?? text(tokens?.refresh_token) ?? text(oauth?.refresh)
  if (!access || !refresh) return
  const idToken = text(tokens?.id_token) ?? text(value.id_token)
  return { accountId, access, refresh, ...(idToken ? { idToken } : {}) }
}

export function codexAuthFileCandidates(homeDir = home()) {
  const primary = path.join(homeDir, ".codex", "auth.json")
  const accountsDir = path.join(homeDir, ".codex", "accounts")
  const accounts = (() => {
    try {
      if (!fs.existsSync(accountsDir)) return []
      return fs.readdirSync(accountsDir)
        .filter((entry) => entry.endsWith(".auth.json"))
        .map((entry) => path.join(accountsDir, entry))
    } catch {
      return []
    }
  })()
  return [primary, ...accounts].filter((file) => fs.existsSync(file))
}

/**
 * Write renewed tokens into every Codex auth file that holds the same account.
 * Returns the files actually rewritten.
 */
export function mirrorCodexTokens(next: RenewedCodexTokens, homeDir = home()): string[] {
  const written: string[] = []
  for (const file of codexAuthFileCandidates(homeDir)) {
    const current = readJsonFile(file)
    if (!current) continue
    const tokens = record(current.tokens)
    if (text(tokens?.account_id) !== next.accountId) continue
    if (text(tokens?.access_token) === next.access && text(tokens?.refresh_token) === next.refresh) continue

    const updated: JsonRecord = {
      ...current,
      tokens: {
        ...(tokens ?? {}),
        access_token: next.access,
        refresh_token: next.refresh,
        // Codex (>=0.143) requires `tokens.id_token`; never regress it to absent.
        ...(next.idToken ?? text(tokens?.id_token) ? { id_token: next.idToken ?? text(tokens?.id_token) } : {}),
      },
      last_refresh: new Date().toISOString(),
    }

    try {
      writeAtomic(file, JSON.stringify(updated, null, 2) + "\n")
      written.push(file)
    } catch (err) {
      log.warn("Failed to mirror renewed Codex tokens", { file, error: String(err) })
    }
  }
  return written
}

function writeAtomic(file: string, contents: string) {
  const temporary = `${file}.claxedo-${process.pid}.tmp`
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 })
    fs.renameSync(temporary, file)
  } catch (err) {
    fs.rmSync(temporary, { force: true })
    throw err
  }
}

function readJsonFile(file: string) {
  try {
    return record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown)
  } catch {
    return
  }
}

function home() {
  return process.env.HOME ?? os.homedir()
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function jsonRecord(input: string) {
  try {
    return record(JSON.parse(input) as unknown)
  } catch {
    return
  }
}

function record(input: unknown): JsonRecord | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as JsonRecord
}
