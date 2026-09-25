import type { ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../contract/projection"
import type { TurnOrigin } from "../contract/session"

export type RuntimePlacement = "desktop" | "loopback" | "self-hosted" | "cloud"
export type CredentialProfile = "owner-login" | "brokered"

export type SelectedAccount = {
  projection: ProviderProjection
  secrets: Readonly<Record<string, string>>
}

export type CredentialSelectionInput = {
  origin: TurnOrigin
  placement: RuntimePlacement
  machineOwnerUserId: string
  canUseOwnLogin: boolean
  profile:
    | { kind: "pi-rpc"; sessionProfile: CredentialProfile; ownerLogin: ResolvedCredentials; brokeredCredentials: ResolvedCredentials }
    | {
        kind: "providers"
        providerIds: readonly string[]
        selectedAccounts: Readonly<Record<string, Readonly<Record<string, SelectedAccount>>>>
        machineCredentials: ResolvedCredentials
        leaseGeneration: string
      }
}

export class CredentialSelectionError extends Error {
  readonly retryable = false
  constructor(readonly code: "account_unavailable" | "origin_mismatch", message: string) {
    super(message)
    this.name = "CredentialSelectionError"
  }
}

function addCredentialSecrets(target: Record<string, string>, source: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(source)) {
    if (Object.hasOwn(target, name) && target[name] !== value) {
      throw new CredentialSelectionError("account_unavailable", `Conflicting secret binding ${name}`)
    }
    target[name] = value
  }
}

function ownerCanUseMachineLogin(input: CredentialSelectionInput): boolean {
  const actor = input.origin.actor
  const isOwner = actor.kind === "machine-owner" || actor.userId === input.machineOwnerUserId
  return isOwner && (input.origin.via === "loopback" || input.origin.via === "owner-grant")
    && input.canUseOwnLogin && (input.placement === "desktop" || input.placement === "loopback")
}

export function selectTurnCredentials(input: CredentialSelectionInput): ResolvedCredentials {
  const profile = input.profile
  const ownerLocal = ownerCanUseMachineLogin(input)
  if (profile.kind === "pi-rpc") {
    const requiredProfile: CredentialProfile = ownerLocal ? "owner-login" : "brokered"
    if (requiredProfile !== profile.sessionProfile) {
      throw new CredentialSelectionError("origin_mismatch", "Turn origin does not match the session credential profile")
    }
    return requiredProfile === "owner-login" ? profile.ownerLogin : profile.brokeredCredentials
  }

  const actor = input.origin.actor
  const userId = actor.kind === "machine-owner" ? input.machineOwnerUserId : actor.userId
  const selections = profile.selectedAccounts[userId] ?? {}
  const providers: Record<string, ProviderProjection> = {}
  const secrets: Record<string, string> = {}
  for (const providerId of profile.providerIds) {
    const selected = selections[providerId]
    if (selected) {
      providers[providerId] = selected.projection
      addCredentialSecrets(secrets, selected.secrets)
      continue
    }
    const machine = ownerLocal ? profile.machineCredentials.providers[providerId] : undefined
    providers[providerId] = machine ?? { unavailable: true, reason: "No selected account for this provider" }
    if (machine) addCredentialSecrets(secrets, profile.machineCredentials.secrets)
  }
  return { providers, secrets, leaseGeneration: profile.leaseGeneration }
}
