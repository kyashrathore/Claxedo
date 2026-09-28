import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"
/**
 * The provider rows the owner pushed to this machine, held in memory only.
 *
 * The ciphertext lives with Electron main, the sealing key with the connector
 * child; this process receives the opened text over loopback and keeps the
 * parsed rows for as long as it runs. A restart holds nothing until main
 * pushes again, which it does from its own store on every launch.
 */

import {
  hostProviderConfigProjectAuth,
  parseHostProviderConfig,
} from "@claxedo/server-core/credentials/host-provider-config"
import { LOCAL_USER_ID } from "@claxedo/server-core/platform/auth/local-identity"
import { holderAccountSources } from "@claxedo/server-core/credentials/account-holder"
import { accountSelections } from "@claxedo/server-core/credentials/account-source"
import { adoptHostEnrolledOwner, hostEnrolledOwner } from "@claxedo/host-serving/serving"
import { createKeyedSerializer } from "@claxedo/helpers"

type HeldProviderConfig = { revision: number; credentials: CredentialSnapshot }

/**
 * One serving change at a time: an ack adopting its owner, a withdrawal and a
 * pushed revision landing between another's steps would leave the older
 * credential, owner or push in force.
 */
export const hostServingUpdates = createKeyedSerializer<"serving">()

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
  held = { revision: input.revision, credentials: parsed.credentials }
  return hostProviderConfigState()
}

/** The pushed rows, read on every `projectAuth` call so a new revision reaches the next turn. */
export function hostProviderConfig(): CredentialSnapshot | undefined {
  return held ? structuredClone(held.credentials) : undefined
}

export function hostProviderConfigState() {
  return {
    revision: held ? held.revision : null,
    providerCount: held ? Object.values(held.credentials.accounts).reduce((count, providers) => count + Object.keys(providers).length, 0) : 0,
  }
}

export function clearHostProviderConfig() {
  held = undefined
}

/** This machine's `projectAuth`: its own accounts under the enrolled owner's pushed rows. */
export function hostCredentialProjectAuth<Input extends { orgId?: string }>(base: (input: Input) => Promise<CredentialSnapshot>) {
  return hostProviderConfigProjectAuth(base, hostProviderConfig, hostEnrolledOwner,
    (owner, input) => holderAccountSources(accountSelections(input.orgId), owner, owner))
}

/** Who this machine's owner is as a person: the enrolled owner, else the unsigned loopback operator. */
export function localMachineOwnerUserId() {
  return hostEnrolledOwner() ?? LOCAL_USER_ID
}

/** Adopt the enrolled owner a serving credential names, re-applying every runtime under them. */
export async function adoptEnrolledOwner(owner: string, reapply: () => Promise<void>): Promise<void> {
  await adoptHostEnrolledOwner(owner, {
    forget: (next) => {
      if (held && held.credentials.machineOwnerUserId !== next) held = undefined
    },
    reapply,
  })
}
