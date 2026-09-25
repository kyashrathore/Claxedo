import type { ProviderProjection } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "../contract/projection"
import type { TurnActor } from "../contract/session"

export type RuntimePlacement = "desktop" | "loopback" | "self-hosted" | "cloud"
export type CredentialProfile = "owner-login" | "brokered"

export type SelectedAccount = {
  projection: ProviderProjection
  secrets: Readonly<Record<string, string>>
}

export type CredentialSelectionInput = {
  owner: TurnActor
  placement: RuntimePlacement
  machineOwnerUserId: string
  canUseOwnLogin: boolean
  profile:
    | { kind: "pi-rpc"; ownerLogin: ResolvedCredentials; brokeredCredentials: ResolvedCredentials }
    | {
        kind: "providers"
        providerIds: readonly string[]
        selectedAccounts: Readonly<Record<string, Readonly<Record<string, SelectedAccount>>>>
        machineCredentials: Readonly<Record<string, SelectedAccount>>
        leaseGeneration: string
      }
}

export class CredentialSelectionError extends Error {
  readonly retryable = false
  constructor(readonly code: "account_unavailable", message: string) {
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
  const owner = input.owner
  const isMachineOwner = owner.kind === "machine-owner" || owner.userId === input.machineOwnerUserId
  return isMachineOwner && input.canUseOwnLogin && (input.placement === "desktop" || input.placement === "loopback")
}

export function selectSessionCredentials(input: CredentialSelectionInput): ResolvedCredentials {
  const profile = input.profile
  const ownerLocal = ownerCanUseMachineLogin(input)
  if (profile.kind === "pi-rpc") {
    return ownerLocal ? profile.ownerLogin : profile.brokeredCredentials
  }

  const owner = input.owner
  const userId = owner.kind === "machine-owner" ? input.machineOwnerUserId : owner.userId
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
    const machine = ownerLocal ? profile.machineCredentials[providerId] : undefined
    providers[providerId] = machine?.projection ?? { unavailable: true, reason: "No selected account for this provider" }
    if (machine && !("unavailable" in machine.projection)) addCredentialSecrets(secrets, machine.secrets)
  }
  return { providers, secrets, leaseGeneration: profile.leaseGeneration }
}
