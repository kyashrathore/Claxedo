import type { CredentialSnapshot, ProviderProjectionSource } from "@claxedo/agent-runtime-contract"
/**
 * What the owner sealed for a host, once it is open again.
 *
 * The plaintext is a `CredentialSnapshot` naming its owner as the machine
 * owner: the same shape `projectAuth` answers, so a pushed credential reaches a
 * harness through the one seam (`configureAgentConfig({ projectAuth })`)
 * rather than a second credential path beside it. Nothing here decrypts — the
 * process holding the machine's sealing key does that and hands the text over.
 *
 * Precedence, and it is the whole policy: a provider the owner pushed replaces
 * whatever this machine would have answered for their own account on that
 * provider, and a provider the owner did not push, or chose the team account
 * for, is untouched. A harness only falls back to the login its own box holds
 * when NO row names its provider, so naming one here is what puts the owner's
 * account ahead of the machine's.
 */

import { credentialSnapshot } from "@claxedo/agent-runtime-contract"
import type { AccountSources } from "./account-holder"

/** Bumped when the sealed shape changes; a host that cannot read a version refuses the whole revision. */
export const HOST_PROVIDER_CONFIG_VERSION = 1

export type HostProviderConfig = {
  version: number
  credentials: CredentialSnapshot
}

export function serializeHostProviderConfig(providers: Record<string, ProviderProjectionSource>, owner: string): string {
  return JSON.stringify({ version: HOST_PROVIDER_CONFIG_VERSION, credentials: { machineOwnerUserId: owner, accounts: { [owner]: providers } } })
}

/**
 * Parse one sealed payload, refusing the whole thing rather than part of it.
 *
 * `onInvalid: "reject"` is the policy for a record that crossed a process
 * boundary: a producer that sent one row this host cannot read has said
 * nothing trustworthy about the rest, and a half-applied credential set runs
 * turns under an identity the owner did not choose.
 */
export function parseHostProviderConfig(text: string): HostProviderConfig {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`pushed provider configuration is not JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("pushed provider configuration must be a JSON object")
  }
  const record: Record<string, unknown> = { ...value }
  if (record.version !== HOST_PROVIDER_CONFIG_VERSION) {
    throw new Error(`pushed provider configuration is version ${String(record.version)}, not ${HOST_PROVIDER_CONFIG_VERSION}`)
  }
  // Validated with the runtime's own reader, so a row that would be refused on
  // apply is refused on arrival instead, where the revision can stay unacked.
  // The validated rows are what is kept: an already-resolved projection is a
  // valid source, and a row naming `placeholderEnv` resolves against an empty
  // environment into an explicit refusal — a host has no sandbox provider to
  // fill such a variable, so the owner sees it disabled rather than silently
  // absent.
  const credentials = credentialSnapshot(record.credentials, {})
  if (!credentials) throw new Error("pushed provider configuration names a provider row this host cannot read")
  return { version: HOST_PROVIDER_CONFIG_VERSION, credentials }
}

/**
 * The `projectAuth` a host composes: this machine's own answer with the
 * enrolled owner's pushed rows written over their accounts.
 *
 * The enrolled owner is the one source of who owns this machine; a pushed
 * snapshot that names anyone else is an earlier enrollment's and is ignored.
 * Both are read on every call, because a revision or an enrollment can land
 * between two turns and the next one must resolve against it without the
 * process being rebuilt.
 */
export function hostProviderConfigProjectAuth<Input>(
  base: ((input: Input) => Promise<CredentialSnapshot>) | undefined,
  pushed: () => CredentialSnapshot | undefined,
  enrolledOwner: () => string | undefined,
  ownerSources: (owner: string, input: Input) => AccountSources,
): (input: Input) => Promise<CredentialSnapshot> {
  return async (input) => {
    const owner = enrolledOwner()
    const local = base ? await base(input) : { machineOwnerUserId: owner ?? "", accounts: {} }
    const remote = pushed()
    if (!owner || !remote || remote.machineOwnerUserId !== owner) return local
    const sources = ownerSources(owner, input)
    const own = Object.fromEntries(Object.entries(remote.accounts[owner] ?? {}).filter(([providerId]) => sources[providerId] !== "team"))
    return { ...local, machineOwnerUserId: owner, accounts: { ...local.accounts, [owner]: { ...local.accounts[owner], ...own } } }
  }
}
