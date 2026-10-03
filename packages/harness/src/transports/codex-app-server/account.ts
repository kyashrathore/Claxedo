import { isProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { StartInput } from "../../contract"
import { codexCredential } from "../../profiles/codex"

function selectedBinding(input: Pick<StartInput, "credentials">) {
  const selected = codexCredential(input.credentials)
  return selected && !isProviderUnavailable(selected) ? selected : undefined
}

export function codexAccountIdentity(input: Pick<StartInput, "credentials" | "sessionId">): string {
  if (!codexCredential(input.credentials)) return "own-login"
  const account = selectedBinding(input)?.account
  return account ? `account:${account.credentialId}` : `session:${input.sessionId}`
}

export function codexLoginKey(input: Pick<StartInput, "credentials">): string | undefined {
  return selectedBinding(input)?.placeholder
}
