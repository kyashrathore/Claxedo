/**
 * What the owner sealed for a host, once it is open again.
 *
 * The plaintext is a `projectAuth` answer and nothing else: the same
 * `ProviderProjectionSource` rows `createLocalCredentialBroker` already emits,
 * so a pushed credential reaches a harness through the one seam
 * (`configureAgentConfig({ projectAuth })`) rather than a second credential
 * path beside it. Nothing here decrypts — the process holding the machine's
 * sealing key does that and hands the text over.
 *
 * Precedence, and it is the whole policy: a provider the owner pushed replaces
 * whatever this machine would have answered for that provider, and a provider
 * the owner did not push is untouched. A harness only falls back to the login
 * its own box holds when NO row names its provider, so naming one here is what
 * puts the owner's account ahead of the machine's.
 */

import {
  providerProjectionRecord,
  type ProviderProjectionSource,
} from "@claxedo/agent-sdk-runtime/provider-projection"

/** Bumped when the sealed shape changes; a host that cannot read a version refuses the whole revision. */
export const HOST_PROVIDER_CONFIG_VERSION = 1

export type HostProviderConfig = {
  version: number
  providers: Record<string, ProviderProjectionSource>
}

export function serializeHostProviderConfig(providers: Record<string, ProviderProjectionSource>): string {
  return JSON.stringify({ version: HOST_PROVIDER_CONFIG_VERSION, providers })
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
  const providers = providerProjectionRecord(record.providers, {}, { onInvalid: "reject" })
  if (!providers) throw new Error("pushed provider configuration names a provider row this host cannot read")
  return { version: HOST_PROVIDER_CONFIG_VERSION, providers }
}

/**
 * The `projectAuth` a host composes: this machine's own answer with the
 * owner's pushed rows written over it.
 *
 * `pushed` is read on every call rather than captured, because a revision can
 * land between two turns and the next one must resolve against it without the
 * process being rebuilt.
 */
export function hostProviderConfigProjectAuth<Input>(
  base: ((input: Input) => Promise<Record<string, ProviderProjectionSource>>) | undefined,
  pushed: () => Record<string, ProviderProjectionSource>,
): (input: Input) => Promise<Record<string, ProviderProjectionSource>> {
  return async (input) => ({ ...(await (base?.(input) ?? Promise.resolve({}))), ...pushed() })
}
