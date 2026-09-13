/**
 * Delivery of an operator's provider accounts into a cloud sandbox through the
 * sandbox provider's own secret edge, and the projection the runtime inside
 * that sandbox receives for them.
 *
 * Both halves are here because they are one decision read twice: the account
 * selected for a provider fixes the vendor host the secret is allowed to reach,
 * the header it is attached in, and the environment variable the harness reads
 * its placeholder from. Splitting them let the two sides disagree about the
 * variable's name, which is a turn that authenticates as nobody.
 *
 * The secret's value never reaches the sandbox: the driver hands it to the
 * provider edge, which substitutes or attaches it on egress to `hosts`.
 */

import type { ProviderProjectionSource } from "@claxedo/agent-sdk-runtime"
import { Log } from "../platform/runtime/lib/log"
import {
  destinationAuthMode,
  providerDestination,
  providerDestinationShape,
  type ProviderDestination,
} from "./destinations"
import {
  readSecretById,
  requireActiveCredentialsForScope,
  SINGLE_TENANT_ORG,
  type CredentialOrgScope,
} from "./registry"
import type { CredentialKind, CredentialMetadata } from "./types"

/**
 * The secret a sandbox driver installs on its provider edge.
 *
 * Structurally `SandboxBrokeredSecret`, restated rather than imported so the
 * credential authority does not take an edge on the sandbox manager; the
 * adapter that hands these to a driver is the one place the two shapes meet.
 */
export type NativeProviderSecret = {
  /** The env var inside the sandbox that carries this credential's placeholder. */
  name: string
  value: string
  hosts: string[]
  /** The vendor header the value belongs in. */
  header: string
  /**
   * The scheme that header's value is prefixed with. A driver that substitutes
   * a placeholder the harness already wrote into `Authorization: Bearer …`
   * ignores it; one that writes the whole header composes it.
   */
  scheme?: string
}

export type NativeProviderDelivery = {
  providerId: string
  /**
   * The stored account this resolved to. Two accounts for one provider commonly
   * both sit at revision 1, so without it a switch between them produces the
   * same delivery identity and a sandbox holding the old one is left holding it.
   */
  credentialId: string
  projection: ProviderProjectionSource
  /** Absent when the projection says the selected account cannot be used. */
  secret?: NativeProviderSecret
  /**
   * The revision the value came from. A rotation that changes nothing but the
   * bytes is visible only here, because the value must not travel into anything
   * that compares or records delivery state.
   */
  revision?: number
  /**
   * The account exists and was not withdrawn; its secret could not be read this
   * time. A caller that already installed this set must hold it rather than
   * treat the row as gone.
   */
  unreadable?: true
}

/** How a sandbox driver can carry a brokered secret, as its catalog declares it. */
export type SandboxSecretBrokering = "native" | "none"

/**
 * Where an account can actually be spent.
 *
 * `local` is always true: the loopback broker holds the value in this process
 * and every stored account reaches it. `cloud` is the narrower question, and it
 * is answered here rather than inferred from "we have it stored", because a
 * provider edge attaches one header per secret and a destination that also
 * needs a fixed companion header cannot be delivered through one at all.
 */
export type CredentialReach = { local: true; cloud: boolean; reason?: string }

export function credentialReach(row: { provider_id: string; kind: CredentialKind }): CredentialReach {
  const destination = providerDestinationShape({ providerId: row.provider_id, kind: row.kind })
  if (!destination) return { local: true, cloud: false, reason: "no_destination" }
  if (destination.injection.headers) {
    return { local: true, cloud: false, reason: "native_delivery_needs_companion_header" }
  }
  return { local: true, cloud: true }
}

const log = Log.create({ service: "native-delivery" })

const ENV_PREFIX = "CLAXEDO_PROVIDER_"

/**
 * The environment variable a provider's placeholder arrives in.
 *
 * Stable across sandboxes and revisions: Daytona's mounted variables only reach
 * processes spawned after a change in the mounted NAMES, so a name derived from
 * anything but the provider would restart the sandbox on every rotation.
 */
export function providerPlaceholderEnv(providerId: string): string {
  return `${ENV_PREFIX}${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
}

function undeliverable(credential: CredentialMetadata, reason: string): NativeProviderDelivery {
  return {
    providerId: credential.provider_id,
    credentialId: credential.id,
    projection: { unavailable: true, reason },
  }
}

function delivery(credential: CredentialMetadata, destination: ProviderDestination): NativeProviderDelivery {
  const providerId = credential.provider_id
  // A destination that also declares fixed companion headers — the ChatGPT
  // account id its backend reads to pick the plan — cannot be delivered here: a
  // provider edge attaches one header per secret, and a turn that arrives
  // without the companion is refused by the vendor, not by us.
  if (destination.injection.headers) return undeliverable(credential, "native_delivery_needs_companion_header")
  const name = providerPlaceholderEnv(providerId)
  return {
    providerId,
    credentialId: credential.id,
    revision: credential.revision,
    secret: {
      name,
      value: destination.value,
      hosts: [new URL(destination.origin).host],
      header: destination.injection.header,
      ...(destination.injection.scheme ? { scheme: destination.injection.scheme } : {}),
    },
    projection: {
      baseUrl: destination.origin,
      placeholderEnv: name,
      authMode: destinationAuthMode(destination),
      ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
    },
  }
}

/**
 * What every account the operator marked active resolves to for a cloud
 * sandbox, usable or not.
 *
 * An unusable one is reported rather than dropped for the reason the loopback
 * broker reports it: an absent projection is indistinguishable from "no account
 * chosen", and a harness reads that as permission to run on the login its image
 * carries. A driver that cannot broker refuses every turn the same way, rather
 * than refusing to provision the workspace at all.
 */
export async function nativeProviderDeliveries(input: {
  org?: CredentialOrgScope
  secretBrokering?: SandboxSecretBrokering
} = {}): Promise<NativeProviderDelivery[]> {
  const org = input.org ?? SINGLE_TENANT_ORG
  const deliveries: NativeProviderDelivery[] = []
  // Each vendor origin is claimed once. Two marked accounts answering on one
  // host — `anthropic` and `claude-sdk` — would otherwise install two
  // unconditional rules for that host and leave the provider edge to pick which
  // identity the turn spends. The most recently marked account claims it,
  // because that mark is the last thing the operator said about the two.
  const claimed = new Map<string, string>()
  for (const row of byMostRecentMark(requireActiveCredentialsForScope("shared", org))) {
    const providerId = row.credential.provider_id
    if (row.unavailable) {
      deliveries.push(undeliverable(row.credential, row.unavailable))
      continue
    }
    if (input.secretBrokering === "none") {
      deliveries.push(undeliverable(row.credential, "secret_brokering_unsupported"))
      continue
    }
    let secret: string | null | undefined
    try {
      secret = await readSecretById(row.credential.id, org)
    } catch (error) {
      // Named, not swallowed: without it a locked keychain reads downstream as
      // an account that stopped existing, and the operator sees a credential
      // refused with no cause anywhere.
      log.warn("Credential secret could not be read for native delivery", {
        providerId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
    }
    if (!secret) {
      deliveries.push({ ...undeliverable(row.credential, "unreadable_secret"), unreadable: true })
      continue
    }
    const destination = providerDestination({ providerId, kind: row.credential.kind, secret })
    if (!destination) {
      deliveries.push(undeliverable(row.credential, "no_destination"))
      continue
    }
    const holder = claimed.get(destination.origin)
    if (holder) {
      deliveries.push(undeliverable(
        row.credential,
        `duplicate_destination_host: ${new URL(destination.origin).host} is delivered for ${holder}, marked more recently`,
      ))
      continue
    }
    claimed.set(destination.origin, providerId)
    deliveries.push(delivery(row.credential, destination))
  }
  return deliveries
}

/**
 * Most recently marked first: the order the operator last stated, which is what
 * decides a vendor host two marked accounts both answer on. `activated_at` and
 * not `updated_at`, because a Check and a rename stamp `updated_at` too, and
 * checking one alias would otherwise hand it the host. The creation time and
 * then the id break a tie, so two rows marked in the same millisecond resolve
 * the same way on every call.
 */
function byMostRecentMark<T extends { credential: CredentialMetadata }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) =>
    (right.credential.activated_at ?? 0) - (left.credential.activated_at ?? 0)
    || right.credential.created_at - left.credential.created_at
    || left.credential.id.localeCompare(right.credential.id))
}

/** The providers whose account exists but could not be read this time. */
export function unreadableDeliveries(deliveries: readonly NativeProviderDelivery[]): string[] {
  return deliveries.flatMap((row) => row.unreadable ? [row.providerId] : [])
}

/**
 * The credential authority for a runtime this process cannot serve: a sandbox
 * whose requests never traverse this machine's loopback, so the credential
 * travels through its own provider's edge.
 *
 * Installed wherever a composition provisions cloud sandboxes, with or without
 * a loopback broker beside it. A composition that answers shared scope with
 * nothing sends the harness no projection at all, and the harness reads that as
 * permission to run on whatever login its image carries.
 */
export async function projectNativeProviderAuth(input: {
  scope: "local" | "shared"
  orgId?: CredentialOrgScope
  secretBrokering?: SandboxSecretBrokering
}): Promise<Record<string, ProviderProjectionSource>> {
  if (input.scope !== "shared") return {}
  return nativeProviderAuth(await nativeProviderDeliveries({
    ...(input.orgId ? { org: input.orgId } : {}),
    ...(input.secretBrokering ? { secretBrokering: input.secretBrokering } : {}),
  }))
}

export function nativeProviderAuth(
  deliveries: readonly NativeProviderDelivery[],
): Record<string, ProviderProjectionSource> {
  const rows: Record<string, ProviderProjectionSource> = {}
  for (const row of deliveries) rows[row.providerId] = row.projection
  return rows
}

export function nativeProviderSecrets(
  deliveries: readonly NativeProviderDelivery[],
): NativeProviderSecret[] {
  return deliveries.flatMap((row) => row.secret ? [row.secret] : [])
}

/**
 * Identity of the delivered set, for deciding whether what a sandbox already
 * holds is current.
 *
 * Reads the account and its revision rather than the value, so the digest can
 * be held on a runtime's state and compared on every wake without a secret
 * living there. A rotation moves the revision and a switch between two accounts
 * moves the credential id, which is what makes a same-named, same-host secret a
 * different set.
 */
export function nativeDeliveryDigest(deliveries: readonly NativeProviderDelivery[]): string {
  return digestEntries(deliveries).map((row) => row.entry).toSorted().join(DIGEST_SEPARATOR)
}

/**
 * The (provider, entry) pairs a digest names, so a caller holding one can tell
 * which providers it installed a secret for and which entries have changed.
 */
export function nativeDeliveryDigestEntries(digest: string): Array<{ providerId: string; entry: string }> {
  if (!digest) return []
  return digest.split(DIGEST_SEPARATOR).flatMap((entry) => {
    const providerId = entry.split(FIELD_SEPARATOR)[0]
    return providerId ? [{ providerId, entry }] : []
  })
}

/**
 * Control characters rather than any printable byte: a provider id, an account
 * id and a host are all free-form enough that a printable separator inside one
 * would forge an entry boundary. Escaped rather than literal so `rg` does not
 * read this file as binary.
 */
const FIELD_SEPARATOR = "\u0000"
const DIGEST_SEPARATOR = "\u0001"

function digestEntries(deliveries: readonly NativeProviderDelivery[]) {
  return deliveries.flatMap((row) => row.secret
    ? [{
      providerId: row.providerId,
      entry: [
        row.providerId,
        row.credentialId,
        row.secret.name,
        row.secret.hosts.join(","),
        row.secret.header,
        row.secret.scheme ?? "",
        String(row.revision ?? ""),
      ].join(FIELD_SEPARATOR),
    }]
    : [])
}
