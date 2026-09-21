import fs from "fs"
import path from "path"
import { accountIdFromClaims } from "@claxedo/agent-runtime-contract"
import type { FetchLike } from "../../adapter-contract"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { asRecord } from "@claxedo/helpers/guards"
import { text, type JsonRecord } from "../shared/sdk-runtime-adapter"

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_ISSUER = "https://auth.openai.com"

export type CodexChatGptTokens = {
  access: string
  refresh?: string
  accountId: string
  idToken?: string
  planType?: string
}

export function sourceAuthValue(input: string | undefined): string | undefined {
  if (!input) return undefined
  let value: JsonRecord | undefined
  try {
    value = asRecord(JSON.parse(input))
  } catch {
    return input
  }
  if (!value || codexChatgptAuthTokens(value)) return undefined
  return text(value.OPENAI_API_KEY)
}

export function sourceCodexAuthValue(input: string | undefined): JsonRecord | undefined {
  if (!input) return undefined
  let value: JsonRecord | undefined
  try {
    value = asRecord(JSON.parse(input))
  } catch {
    return undefined
  }
  if (!value) return undefined
  const chatgpt = value.type === "codex_auth" || value.auth_mode === "chatgpt" || !!codexChatgptAuthTokens(value)
  return chatgpt ? value : undefined
}

export function readCodexAuthFile(home: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

export async function writeCodexAuthFile(home: string, input: JsonRecord | undefined) {
  if (!input) return
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 })
  // `lstat` answers the entry's own type: a home swapped for a link fails here
  // instead of placing the credential file wherever the link points.
  const stat = await fs.promises.lstat(home)
  if (!stat.isDirectory()) throw new Error(`Codex home at ${home} is not a directory`)
  // `mkdir` applies its mode only to a directory it creates; a pre-existing or
  // umask-widened home is narrowed on every write instead.
  if (stat.mode & 0o077) await fs.promises.chmod(home, 0o700)
  // Staging then renaming replaces whatever sits at `auth.json` — a permissive
  // mode and a symlink included — rather than opening through the name.
  await writePrivateFileAtomic(path.join(home, "auth.json"), JSON.stringify(input, null, 2) + "\n")
}

export function codexChatgptAuthTokens(input: JsonRecord | undefined): CodexChatGptTokens | undefined {
  if (!input) return undefined
  const tokens = asRecord(input.tokens)
  const oauth = asRecord(input.oauth)
  const access = text(input.access) ?? text(tokens?.access_token) ?? text(oauth?.access)
  const refresh = text(input.refresh) ?? text(tokens?.refresh_token) ?? text(oauth?.refresh)
  const idToken = text(input.id_token) ?? text(tokens?.id_token) ?? text(oauth?.id_token)
  const accountId = text(input.account_id)
    ?? text(input.accountId)
    ?? text(tokens?.account_id)
    ?? text(oauth?.account_id)
    ?? accountIdFromClaims(input)
  if (!access || !accountId) return undefined
  const planType = text(input.chatgptPlanType) ?? text(input.plan_type) ?? text(oauth?.plan_type)
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(idToken ? { idToken } : {}),
    accountId,
    ...(planType ? { planType } : {}),
  }
}

export function mergeCodexAuth(input: JsonRecord | undefined, tokens: {
  access: string
  refresh: string
  accountId: string
  idToken?: string
  planType?: string
}) {
  const current = input ?? { type: "codex_auth", auth_mode: "chatgpt" }
  const existingTokens = asRecord(current.tokens) ?? {}
  const existingOauth = asRecord(current.oauth) ?? {}
  const idToken = tokens.idToken ?? text(existingTokens.id_token) ?? text(existingOauth.id_token)
  return {
    ...current,
    type: "codex_auth",
    auth_mode: text(current.auth_mode) ?? "chatgpt",
    tokens: {
      ...existingTokens,
      ...(idToken ? { id_token: idToken } : {}),
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      account_id: tokens.accountId,
    },
    access: tokens.access,
    refresh: tokens.refresh,
    account_id: tokens.accountId,
    last_refresh: new Date().toISOString(),
    oauth: {
      ...existingOauth,
      ...(idToken ? { id_token: idToken } : {}),
      access: tokens.access,
      refresh: tokens.refresh,
      account_id: tokens.accountId,
      ...(tokens.planType ? { plan_type: tokens.planType } : {}),
    },
  }
}

export async function refreshCodexChatgptAuth(input: {
  auth: JsonRecord | undefined
  home: string
  fetch?: FetchLike
}) {
  const current = codexChatgptAuthTokens(input.auth) ?? codexChatgptAuthTokens(readCodexAuthFile(input.home))
  if (!current?.refresh) {
    throw new Error("Codex ChatGPT auth is missing a refresh token. Run `codex login` or sync a valid Codex credential, then retry.")
  }
  const response = await (input.fetch ?? fetch)(`${OPENAI_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: OPENAI_CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Codex ChatGPT auth refresh failed (${response.status}). Run \`codex login\` or sync a valid Codex credential, then retry.`)
  }
  const row = asRecord(await response.json().catch(() => undefined))
  const access = text(row?.access_token)
  const refresh = text(row?.refresh_token) ?? current.refresh
  if (!access) throw new Error("Codex ChatGPT auth refresh returned no access token")
  const tokens = {
    access,
    refresh,
    accountId: text(row?.account_id) ?? accountIdFromClaims(row) ?? current.accountId,
    idToken: text(row?.id_token) ?? current.idToken,
    planType: current.planType,
  }
  const auth = mergeCodexAuth(input.auth ?? readCodexAuthFile(input.home), tokens)
  await writeCodexAuthFile(input.home, auth)
  return {
    auth,
    login: {
      accessToken: tokens.access,
      chatgptAccountId: tokens.accountId,
      chatgptPlanType: tokens.planType ?? null,
    },
  }
}
