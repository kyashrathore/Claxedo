import { expiryFromJwt, HARNESS_TABLE, type ProviderDirect } from "@claxedo/agent-runtime-contract"
import type { Clock, StartInput } from "../../contract"
import { codexPlanAccountId, selectedCodexAccount } from "../../profiles/codex"

const RENEW_BEFORE_MS = 10 * 60 * 1000

export type CodexLogin = { type: "apiKey"; apiKey: string } | { type: "chatgptAuthTokens"; accessToken: string; chatgptAccountId: string }

export type CodexPlanRefresh = (input: { credentialProviderId: string; rejectedExpiresAt?: number }) => Promise<ProviderDirect | undefined>

export function codexAccountIdentity(input: Pick<StartInput, "credentials" | "sessionId">): string {
  const account = selectedCodexAccount(input.credentials)
  if (!account) return "own-login"
  const credential = account.kind === "brokered" ? account.binding.account : account.plan.account
  return credential ? `account:${credential.credentialId}` : `session:${input.sessionId}`
}

function tokenExpiry(row: ProviderDirect): number | undefined {
  return expiryFromJwt(row.secret) ?? row.expiresAt
}

function planLogin(row: ProviderDirect): CodexLogin {
  return { type: "chatgptAuthTokens", accessToken: row.secret, chatgptAccountId: codexPlanAccountId(row) }
}

export class CodexAccountLogin {
  private renewed?: ProviderDirect

  constructor(private readonly start: () => StartInput, private readonly refresh: CodexPlanRefresh, private readonly clock: Clock) {}

  async current(): Promise<CodexLogin | undefined> {
    const account = selectedCodexAccount(this.start().credentials)
    if (!account) return undefined
    if (account.kind === "brokered") return { type: "apiKey", apiKey: account.binding.placeholder }
    const row = this.newest(account.plan)
    const expiresAt = tokenExpiry(row)
    const due = expiresAt !== undefined && expiresAt - this.clock.now() < RENEW_BEFORE_MS
    return planLogin((due ? await this.renew(row) : undefined) ?? row)
  }

  async refused(): Promise<CodexLogin | undefined> {
    const account = selectedCodexAccount(this.start().credentials)
    if (account?.kind !== "plan") return undefined
    const renewed = await this.renew(this.newest(account.plan))
    return renewed ? planLogin(renewed) : undefined
  }

  private newest(row: ProviderDirect): ProviderDirect {
    const renewed = this.renewed
    const same = renewed?.account?.credentialId === row.account?.credentialId
    return renewed && same && (tokenExpiry(renewed) ?? 0) >= (tokenExpiry(row) ?? 0) ? renewed : row
  }

  private async renew(row: ProviderDirect): Promise<ProviderDirect | undefined> {
    const next = await this.refresh({ credentialProviderId: HARNESS_TABLE.codex.connectProvider, rejectedExpiresAt: tokenExpiry(row) ?? this.clock.now() })
    if (next?.authKind !== "subscription" || next.secret === row.secret) return undefined
    this.renewed = next
    return next
  }
}
