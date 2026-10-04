import type { CredentialSnapshot, ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../contract/projection"
import type { TurnActor } from "../contract/session"
import { ownerMayUseMachineLogin, selectedProviderProjection, type MachineLoginPolicy } from "../contract/credentials"

export type CredentialProfile = "owner-login" | "brokered"

export type CredentialSelectionInput = CredentialSnapshot<ProviderProjection> & MachineLoginPolicy & {
  leaseGeneration: string
  providerIds?: readonly string[]
  directDelivery?: boolean
}

export class CredentialSelectionError extends Error {
  readonly retryable = false
  constructor(readonly code: "account_unavailable", message: string) {
    super(message)
    this.name = "CredentialSelectionError"
  }
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
    throw new CredentialSelectionError("account_unavailable", selected.reason)
  }
  if (!selected && !directSelected && !machineLoginAllowed) {
    throw new CredentialSelectionError("account_unavailable", `No selected account for session owner ${userId}`)
  }
  return result
}
