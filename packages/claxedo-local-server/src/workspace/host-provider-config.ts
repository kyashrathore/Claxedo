/**
 * The provider rows the owner pushed to this machine, held in memory only.
 *
 * The ciphertext lives with Electron main, the sealing key with the connector
 * child; this process receives the opened text over loopback and keeps the
 * parsed rows for as long as it runs. A restart holds nothing until main
 * pushes again, which it does from its own store on every launch.
 */

import {
  parseHostProviderConfig,
} from "@claxedo/server-core/credentials/host-provider-config"
import type { ProviderProjectionSource } from "@claxedo/agent-sdk-runtime"

type HeldProviderConfig = { revision: number; providers: Record<string, ProviderProjectionSource> }

let held: HeldProviderConfig | undefined

/** A revision below the held one, which would put back a credential the owner rotated or withdrew. */
export class HostProviderConfigStaleError extends Error {
  constructor(readonly held: number, readonly offered: number) {
    super(`provider configuration revision ${offered} is below the held revision ${held}`)
    this.name = "HostProviderConfigStaleError"
  }
}

/**
 * Replace the held rows with one revision's text.
 *
 * Throws, changing nothing, when a row is unreadable: the revision then stays
 * unacked at the control plane through the child's refusal to forward, and the
 * rows already held keep answering. A revision below the held one throws too —
 * the machine applies only what moves forward, so a rollback cannot reinstate a
 * rotated key here either. The same revision re-installs, which is what makes
 * main's re-push after a daemon restart a no-op rather than a refusal.
 */
export function installHostProviderConfigRevision(input: { revision: number; providers: string }) {
  if (held && input.revision < held.revision) throw new HostProviderConfigStaleError(held.revision, input.revision)
  const parsed = parseHostProviderConfig(input.providers)
  held = { revision: input.revision, providers: parsed.providers }
  return hostProviderConfigState()
}

/** The pushed rows, read on every `projectAuth` call so a new revision reaches the next turn. */
export function hostProviderConfig(): Record<string, ProviderProjectionSource> {
  return held ? { ...held.providers } : {}
}

export function hostProviderConfigState() {
  return {
    revision: held ? held.revision : null,
    providerCount: held ? Object.keys(held.providers).length : 0,
  }
}

export function clearHostProviderConfig() {
  held = undefined
}
