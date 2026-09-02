import fs from "fs"
import path from "path"
import type { FetchLike } from "../../adapter-contract"
import { record, text, type JsonRecord } from "../shared/sdk-runtime-adapter"

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_ISSUER = "https://auth.openai.com"

export type CodexChatGptTokens = {
  access: string
  refresh?: string
  accountId: string
  idToken?: string
  planType?: string
}

export function sourceAuthValue(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as JsonRecord
    if (codexChatgptAuthTokens(value)) return
    return text(value.OPENAI_API_KEY)
  } catch {
    return input
  }
}

export function sourceCodexAuthValue(input: string | undefined) {
  if (!input) return
  try {
    const value = JSON.parse(input) as JsonRecord
    if (value.type === "codex_auth" || value.auth_mode === "chatgpt" || codexChatgptAuthTokens(value)) return value
  } catch {
    return
  }
}

export function readCodexAuthFile(home: string) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")) as JsonRecord
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function writeCodexAuthFile(home: string, input: JsonRecord | undefined) {
  if (!input) return
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 })
  await fs.promises.writeFile(path.join(home, "auth.json"), JSON.stringify(input, null, 2) + "\n", { mode: 0o600 })
}

export function codexChatgptAuthTokens(input: JsonRecord | undefined): CodexChatGptTokens | undefined {
  if (!input) return
  const tokens = record(input.tokens)
  const oauth = record(input.oauth)
  const access = text(input.access) ?? text(tokens?.access_token) ?? text(oauth?.access)
  const refresh = text(input.refresh) ?? text(tokens?.refresh_token) ?? text(oauth?.refresh)
  const idToken = text(input.id_token) ?? text(tokens?.id_token) ?? text(oauth?.id_token)
  const accountId = text(input.account_id)
    ?? text(input.accountId)
    ?? text(tokens?.account_id)
    ?? text(oauth?.account_id)
    ?? accountIdFromClaims(input)
  if (!access || !accountId) return
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
  const existingTokens = record(current.tokens) ?? {}
  const existingOauth = record(current.oauth) ?? {}
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
  const row = record(await response.json().catch(() => undefined))
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

export function accountIdFromClaims(input: JsonRecord | undefined) {
  return accountIdFromJwt(text(input?.id_token) ?? text(record(input?.tokens)?.id_token))
    ?? accountIdFromJwt(text(input?.access_token) ?? text(input?.access) ?? text(record(input?.tokens)?.access_token))
}

function accountIdFromJwt(token: string | undefined) {
  if (!token) return
  const payload = token.split(".")[1]
  if (!payload) return
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JsonRecord
    const openai = record(claims["https://api.openai.com/auth"])
    return text(claims.chatgpt_account_id) ?? text(openai?.chatgpt_account_id)
  } catch {
    return
  }
}
