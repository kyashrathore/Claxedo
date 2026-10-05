import { HARNESS_NEEDS_BROKERING, isProviderUnavailable, piProviderSpending, type CredentialSnapshot, type PiLaunchProvider,
  type ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../contract/projection"
import type { TurnActor } from "../contract/session"
import { ownerMayUseMachineLogin, selectedProviderProjection, type MachineLoginPolicy } from "../contract/credentials"

export type CredentialProfile = "owner-login" | "brokered"

export type CredentialSelectionInput = CredentialSnapshot<ProviderProjection> & MachineLoginPolicy & {
  leaseGeneration: string
  providerIds?: readonly string[]
  directDelivery?: boolean
}

type RefusalDetail = { reason?: string; piProvider?: PiLaunchProvider }

export class CredentialSelectionError extends Error {
  readonly retryable = false
  constructor(readonly code: "account_unavailable" | typeof HARNESS_NEEDS_BROKERING, message: string, readonly detail: RefusalDetail = {}) {
    super(message)
    this.name = "CredentialSelectionError"
  }
}

export function accountUnusable(reason: string) {
  return new CredentialSelectionError("account_unavailable", "The account chosen for this harness can't be used here. Check it in Settings → Models.", { reason })
}

export function noAccountChosen() {
  return new CredentialSelectionError("account_unavailable", "No account is chosen for this harness. Add one in Settings → Models.")
}

function unavailableAccount(providers: Readonly<Record<string, ProviderProjection>>, providerIds: readonly string[], reason: string) {
  if (reason !== HARNESS_NEEDS_BROKERING) return accountUnusable(reason)
  const refused = providerIds.find((id) => Object.hasOwn(providers, id) && isProviderUnavailable(providers[id]!))
  const piProvider = refused ? piProviderSpending(refused) : undefined
  return new CredentialSelectionError(HARNESS_NEEDS_BROKERING, "This cloud provider can't keep the account's key out of the workspace.",
    piProvider ? { piProvider } : {})
}

export type SessionAccountOwner = { userId: string; machineLoginAllowed: boolean }

export function sessionAccountOwner(policy: MachineLoginPolicy, owner: TurnActor): SessionAccountOwner {
  return {
    userId: owner.kind === "machine-owner" ? policy.machineOwnerUserId : owner.userId,
    machineLoginAllowed: ownerMayUseMachineLogin(owner, policy),
  }
}

export function selectSessionCredentials(snapshot: CredentialSelectionInput, owner: TurnActor): ResolvedCredentials {
  const { userId, machineLoginAllowed } = sessionAccountOwner(snapshot, owner)
  const providers = Object.hasOwn(snapshot.accounts, userId) ? snapshot.accounts[userId]! : {}
  const direct = snapshot.directDelivery && snapshot.direct && Object.hasOwn(snapshot.direct, userId) ? snapshot.direct[userId] : undefined
  const result = { accountOwner: userId, providers, ...(direct ? { direct } : {}), secrets: {}, leaseGeneration: snapshot.leaseGeneration, machineLoginAllowed }
  if (!snapshot.providerIds) return result
  const selected = selectedProviderProjection(result, snapshot.providerIds)
  const directSelected = direct !== undefined && snapshot.providerIds.some((id) => Object.hasOwn(direct, id))
  if (selected && "unavailable" in selected && !directSelected) {
    throw unavailableAccount(providers, snapshot.providerIds, selected.reason)
  }
  if (!selected && !directSelected && !machineLoginAllowed) {
    throw noAccountChosen()
  }
  return result
}
