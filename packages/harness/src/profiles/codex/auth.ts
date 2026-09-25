import fs from "node:fs/promises"
import path from "node:path"
import { accountIdFromClaims } from "@claxedo/agent-runtime-contract"
import { writePrivateFileAtomic } from "@claxedo/helpers/fs"
import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"

type AuthDocument = Record<string, unknown>
export type CodexAuthFetch = (url: string, init: RequestInit) => Promise<Response>

async function readAuth(home: string): Promise<AuthDocument> {
  const value = await fs.readFile(path.join(home, "auth.json"), "utf8")
  return asRecordOrEmpty(JSON.parse(value))
}

export async function refreshCodexChatgptTokens(home: string, request: CodexAuthFetch = fetch): Promise<{
  accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null
}> {
  const auth = await readAuth(home)
  const tokens = asRecordOrEmpty(auth.tokens)
  const oauth = asRecordOrEmpty(auth.oauth)
  const refreshToken = asString(tokens.refresh_token) ?? asString(oauth.refresh) ?? asString(auth.refresh)
  const accountId = asString(tokens.account_id) ?? asString(oauth.account_id) ?? asString(auth.account_id)
    ?? asString(auth.accountId) ?? accountIdFromClaims(auth)
  if (!refreshToken || !accountId) throw new Error("Codex ChatGPT login has no refresh token or account ID")
  const response = await request("https://auth.openai.com/oauth/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann" }).toString() })
  if (!response.ok) throw new Error(`Codex ChatGPT token refresh failed (${response.status})`)
  const row = asRecordOrEmpty(await response.json())
  const access = asString(row.access_token)
  if (!access) throw new Error("Codex ChatGPT token refresh returned no access token")
  const nextRefresh = asString(row.refresh_token) ?? refreshToken
  const nextAccount = asString(row.account_id) ?? accountIdFromClaims(row) ?? accountId
  const idToken = asString(row.id_token) ?? asString(tokens.id_token) ?? asString(oauth.id_token)
  const planType = asString(auth.chatgptPlanType) ?? asString(auth.plan_type) ?? asString(oauth.plan_type) ?? null
  const next = { ...auth, type: "codex_auth", auth_mode: asString(auth.auth_mode) ?? "chatgpt",
    tokens: { ...tokens, access_token: access, refresh_token: nextRefresh, account_id: nextAccount,
      ...(idToken ? { id_token: idToken } : {}) },
    access, refresh: nextRefresh, account_id: nextAccount, last_refresh: new Date().toISOString(),
    oauth: { ...oauth, access, refresh: nextRefresh, account_id: nextAccount,
      ...(idToken ? { id_token: idToken } : {}), ...(planType ? { plan_type: planType } : {}) } }
  await writePrivateFileAtomic(path.join(home, "auth.json"), `${JSON.stringify(next, null, 2)}\n`)
  return { accessToken: access, chatgptAccountId: nextAccount, chatgptPlanType: planType }
}
