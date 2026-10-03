import type { StartInput } from "../../contract"
import { selectedCodexAccount } from "../../profiles/codex"

export function codexAccountIdentity(input: Pick<StartInput, "credentials" | "sessionId">): string {
  const selected = selectedCodexAccount(input.credentials)
  if (!selected) return "own-login"
  return selected.account ? `account:${selected.account.credentialId}` : `session:${input.sessionId}`
}

export function codexLoginKey(input: Pick<StartInput, "credentials">): string | undefined {
  return selectedCodexAccount(input.credentials)?.placeholder
}
