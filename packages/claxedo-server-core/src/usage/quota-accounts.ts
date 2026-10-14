import { HARNESS_IDS, HARNESS_TABLE, harnessForProviderId, isHarnessId } from "@claxedo/agent-runtime-contract"
import { accountHolderOf } from "../credentials/account-holder"
import { fanoutEligible } from "../credentials/account-kinds"
import { credentialReach } from "../credentials/reach"
import { isSubscriptionKind } from "../credentials/secret-material"
import type { ControlPlaneCredentials } from "../authority/control-plane-contract"
import type { CredentialCheckOutcome } from "../credentials/operations/check"
import type { CredentialHealth, CredentialMetadata, CredentialVerdictEvidence } from "../credentials/types"
import type { QuotaAccount, QuotaSnapshot, UnifiedUsageResponse } from "@claxedo/usage-contract"

export const INFERENCE_ONLY_LOGIN = "Setup-tokens are inference-only, so this account runs turns but cannot report its plan usage. Sign the Claude CLI in to this account to see it."

const REFUSED_LOGIN: Readonly<Record<Exclude<CredentialHealth, "ok">, string>> = {
  auth_failed: "The provider refused this login, so its limits cannot be read. Sign in to this account again.",
  expired: "This login has expired, so its limits cannot be read. Sign in to this account again.",
  no_billing: "The provider reports no active plan on this account.",
  rate_capped: "The provider is rate-limiting this account right now; its limits can be read again later.",
}

/**
 * What the last Check of an account has to say that its stored row cannot:
 * a Check that could not conclude, a login whose secret is gone, and a plan
 * read the vendor refused on an account it accepted. A concluded Check with
 * windows says nothing here — the windows are the answer.
 */
export type CheckWord = { reason: string | undefined; concluded: boolean }

export function checkWord(outcome: CredentialCheckOutcome): CheckWord {
  if (outcome.status === "checked") {
    return { reason: outcome.usageRefused ? usageReadRefusedReason(outcome.usageRefused) : undefined, concluded: true }
  }
  if (outcome.status === "failed") return { reason: `This account's limits could not be read: ${outcome.detail.message}`, concluded: false }
  return {
    reason: outcome.status === "no_secret"
      ? "This account's stored login is missing, so its limits cannot be read. Sign in to this account again."
      : "Claxedo cannot read plan usage here.",
    concluded: false,
  }
}

/**
 * A concluded Check's word on the read it just made outranks what the stored
 * row implies; a Check that could not conclude leaves the stored verdict's
 * copy, and windows on the card are the answer whatever the Check said.
 */
export function withCheckWord(card: QuotaAccount, checked: CheckWord | undefined): QuotaAccount {
  if (checked?.reason === undefined || card.windows.length > 0) return card
  return checked.concluded || card.usageError === undefined ? { ...card, usageError: checked.reason } : card
}

/**
 * Anthropic answers the plan read with `permission_error` for a token minted
 * without `user:profile` — a `claude setup-token` — and throttles the route
 * per token with a retry-after of nearly an hour while every turn keeps
 * running. Neither is the account's fault, and the card says which it was.
 */
function usageReadRefusedReason(refusal: CredentialVerdictEvidence): string {
  if (refusal.status === 403 && refusal.type === "permission_error") return INFERENCE_ONLY_LOGIN
  if (refusal.status === 429) {
    const minutes = refusal.retryAfterSeconds === undefined ? undefined : Math.max(1, Math.ceil(refusal.retryAfterSeconds / 60))
    return `The provider is throttling this account's plan read; this account runs turns, and its limits can be read again ${minutes === undefined ? "later" : `in ${minutes} min`}.`
  }
  return `The provider answered ${refusal.status}${refusal.type ? ` ${refusal.type}` : ""} to this account's plan read, so its limits could not be read. This account still runs turns.`
}

/**
 * The stored rows one person's quota view may draw: their own accounts and the
 * organization's harness accounts any member may choose to spend, never
 * another member's.
 */
export function visibleTo(person: string) {
  return (row: CredentialMetadata) =>
    row.owner === null || row.owner === undefined ? fanoutEligible(row) : accountHolderOf(row.owner, person) === person
}

/** One stored login is one row per binding its harness resolves auth through. */
export type StoredAccount = {
  harness: string
  identity: string
  /** The row the account is keyed by; the others are its other bindings. */
  first: CredentialMetadata
  ids: string[]
  rows: CredentialMetadata[]
}

/** The harness a stored row belongs to, or the provider itself where it belongs to none. */
export function harnessOf(row: Pick<CredentialMetadata, "provider_id">): string {
  return harnessForProviderId(row.provider_id) ?? row.provider_id
}

/**
 * The stored rows that stand for a plan, folded by the account they name.
 *
 * A key authenticates a project and has no plan window to report, so only the
 * kinds that are a subscription by their metadata alone are listed: an account
 * that cannot have windows must not read as one whose windows are missing.
 */
export function storedAccounts(rows: readonly CredentialMetadata[]): StoredAccount[] {
  const groups = new Map<string, StoredAccount>()
  for (const row of rows) {
    if (!isSubscriptionKind(row.kind)) continue
    const harness = harnessOf(row)
    const identity = row.account_id ?? row.id
    const held = groups.get(`${harness} ${identity}`)
    if (held) {
      held.ids.push(row.id)
      held.rows.push(row)
      continue
    }
    groups.set(`${harness} ${identity}`, { harness, identity, first: row, ids: [row.id], rows: [row] })
  }
  return [...groups.values()]
}

/**
 * The stored rows a harness would actually send, which is what "in use" means
 * on the Providers list.
 *
 * `effectiveCredentials` answers it directly, and an empty answer from it is an
 * answer: no stored account is in use, and every harness runs on the login its
 * own CLI holds. A store that does not implement it cannot answer at all, and
 * only there is the active mark the best evidence available — a mark says which
 * account was chosen, not which one is usable.
 */
export async function accountsInUse(
  credentials: ControlPlaneCredentials,
  org: string,
  rows: readonly CredentialMetadata[],
  visible: (row: CredentialMetadata) => boolean,
): Promise<Set<string>> {
  const effective = await credentials.effectiveCredentials?.("local", org)
  if (effective === undefined) return new Set(rows.filter((row) => row.is_active).map((row) => row.id))
  const byProvider = new Map(effective.filter(visible).map((row) => [row.provider_id, row.id]))
  return new Set(
    [...new Set(rows.map(harnessOf))].flatMap((harness) => {
      const providerIds = isHarnessId(harness) ? HARNESS_TABLE[harness].providerIds : [harness]
      const id = providerIds.map((provider) => byProvider.get(provider)).find((value) => value !== undefined)
      return id === undefined ? [] : [id]
    }),
  )
}

/**
 * Why a stored account that the provider has answered carries no windows.
 *
 * A Claude login the provider accepted and that reported no windows is a
 * `claude setup-token`: minted with the inference scope only, it can run
 * every turn and cannot read the plan. Claude only: a ChatGPT usage read that
 * names no window is an empty answer, not a scope.
 */
function withoutWindowsReason(account: StoredAccount, health: CredentialHealth | undefined, checkedAt: number | undefined): string | undefined {
  if (health === undefined || checkedAt === undefined) return undefined
  if (health !== "ok") return REFUSED_LOGIN[health]
  return account.harness === "claude" ? INFERENCE_ONLY_LOGIN : undefined
}

export function storedQuotaAccount(account: StoredAccount, inUse: ReadonlySet<string>): QuotaAccount {
  const read = account.rows.find((row) => row.usage_windows?.length)
  const named = account.rows
    .map((row) => row.label?.trim())
    .find((label) => label && label !== account.first.provider_id)
  const health = account.rows.map((row) => row.health).find((value) => value != null) ?? undefined
  const checkedAt = account.rows.map((row) => row.last_validated_at).find((value) => value != null) ?? undefined
  const reason = read ? undefined : withoutWindowsReason(account, health, checkedAt)
  return {
    harness: account.harness,
    credentialId: account.first.id,
    label: named ?? account.identity,
    inUse: account.ids.some((id) => inUse.has(id)),
    // Every row of one account is the same login stored per binding, so the
    // account reaches a cloud sandbox exactly where any of them does.
    deliverable: account.rows.map((row) => credentialReach(row)).find((reach) => reach.cloud) ?? credentialReach(account.first),
    ...(health === undefined ? {} : { health }),
    windows: read?.usage_windows ?? [],
    ...(read?.usage_at == null ? {} : { usageAt: read.usage_at }),
    ...(reason === undefined ? {} : { usageAt: checkedAt, usageError: reason }),
  }
}

/**
 * Harnesses in the order the Providers list shows them, and within each one the
 * account its next turn runs on first. The agents Claxedo cannot run come last
 * whatever they are called: they answer a different question from every card
 * above them, and a reader looking for their own plan reads downwards.
 */
export function orderAccounts(accounts: readonly QuotaAccount[]): QuotaAccount[] {
  const rank = (account: QuotaAccount) =>
    account.otherAgent
      ? HARNESS_IDS.length + 1
      : isHarnessId(account.harness)
        ? HARNESS_IDS.indexOf(account.harness)
        : HARNESS_IDS.length
  return [...accounts].sort((a, b) =>
    rank(a) - rank(b)
    || a.harness.localeCompare(b.harness)
    || Number(b.inUse) - Number(a.inUse))
}

/**
 * Whether there is anything to draw. What is true of one account — unread,
 * refused, reporting no plan — travels on that account, because a view that
 * summarised those into one word could only say something vaguer than each
 * card already says.
 */
export function quotaStatus(snapshot: QuotaSnapshot): UnifiedUsageResponse["quota"]["status"] {
  return snapshot.accounts.some((account) => account.windows.length > 0) ? "available" : "unavailable"
}
