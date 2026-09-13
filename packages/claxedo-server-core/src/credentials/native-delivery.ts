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
import { providerDestination, type ProviderDestination } from "./destinations"
import {
  readSecretById,
  requireActiveCredentialsForScope,
  SINGLE_TENANT_ORG,
  type CredentialOrgScope,
} from "./registry"
import type { CredentialMetadata } from "./types"

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
  projection: ProviderProjectionSource
  /** Absent when the projection says the selected account cannot be used. */
  secret?: NativeProviderSecret
}

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

function authMode(destination: ProviderDestination): "api-key" | "bearer" {
  return destination.injection.header.toLowerCase() === "authorization" ? "bearer" : "api-key"
}

function undeliverable(providerId: string, reason: string): NativeProviderDelivery {
  return { providerId, projection: { unavailable: true, reason } }
}

function delivery(credential: CredentialMetadata, destination: ProviderDestination): NativeProviderDelivery {
  const providerId = credential.provider_id
  // A destination that also declares fixed companion headers — the ChatGPT
  // account id its backend reads to pick the plan — cannot be delivered here: a
  // provider edge attaches one header per secret, and a turn that arrives
  // without the companion is refused by the vendor, not by us.
  if (destination.injection.headers) return undeliverable(providerId, "native_delivery_needs_companion_header")
  const name = providerPlaceholderEnv(providerId)
  return {
    providerId,
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
      authMode: authMode(destination),
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
 * carries.
 */
export async function nativeProviderDeliveries(
  org: CredentialOrgScope = SINGLE_TENANT_ORG,
): Promise<NativeProviderDelivery[]> {
  const deliveries: NativeProviderDelivery[] = []
  for (const row of requireActiveCredentialsForScope("shared", org)) {
    if (row.unavailable) {
      deliveries.push(undeliverable(row.credential.provider_id, row.unavailable))
      continue
    }
    const secret = await readSecretById(row.credential.id, org)
    if (!secret) {
      deliveries.push(undeliverable(row.credential.provider_id, "unreadable_secret"))
      continue
    }
    const destination = providerDestination({
      providerId: row.credential.provider_id,
      kind: row.credential.kind,
      secret,
    })
    if (!destination) {
      deliveries.push(undeliverable(row.credential.provider_id, "no_destination"))
      continue
    }
    deliveries.push(delivery(row.credential, destination))
  }
  return deliveries
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
