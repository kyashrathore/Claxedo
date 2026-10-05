import { createHash } from "node:crypto"
import { accountHolderOf, holderAccountSources, ORG_ACCOUNT_UNAVAILABLE, selectedAccounts, spendsAccount, type AccountSelections } from "./account-holder"
import { HARNESS_NEEDS_BROKERING, type CredentialSnapshot, type ProviderDirect, type ProviderProjectionSource } from "@claxedo/agent-runtime-contract"
import { destinationAuthMode, builtInProviderDestination, builtInProviderDestinationShape, type ProviderDestination } from "./built-in-destinations"
import type { CredentialKind, CredentialMetadata } from "./types"
import { isSubscriptionKind } from "./secret-material"
import { deliveredDirect } from "./reach"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"

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
   * The methods and path prefixes the value may be attached to, as the
   * provider's own destination row declares them. A provider edge is configured
   * from these and refuses everything else, so an empty list is not "no
   * restriction" — the Cloudflare Worker answers 403 and Vercel writes no
   * transform at all.
   */
  methods: readonly string[]
  pathPrefixes: readonly string[]
  /**
   * The scheme that header's value is prefixed with. A driver that substitutes
   * a placeholder the harness already wrote into `Authorization: Bearer …`
   * ignores it; one that writes the whole header composes it.
   */
  scheme?: string
}

export type NativeProviderDelivery = {
  /** The person whose account this is; null for the org's account. */
  userId: string | null
  providerId: string
  /**
   * The stored account this resolved to. Two accounts for one provider commonly
   * both sit at revision 1, so without it a switch between them produces the
   * same delivery identity and a sandbox holding the old one is left holding it.
   */
  credentialId: string
  /** Absent when the projection says the selected account cannot be used, or the account is handed over `direct`. */
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
} & (
  | { projection: ProviderProjectionSource; direct?: undefined }
  /** A plan login a harness signs in with itself: no edge holds it, and no binding stands for it. */
  | { direct: ProviderDirect; projection?: undefined }
)

export type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"

const ENV_PREFIX = "CLAXEDO_PROVIDER_"

/**
 * The environment variable an account's placeholder arrives in, named for the
 * stored account (its row id is random) rather than for any person, so code in
 * the sandbox cannot name another account's placeholder from who owns it.
 *
 * Stable across rotations, because a rotation keeps the row.
 */
export function accountPlaceholderEnv(credential: Pick<CredentialMetadata, "id" | "provider_id">): string {
  const binding = createHash("sha256").update(credential.id).digest("hex").slice(0, 24).toUpperCase()
  return `${ENV_PREFIX}${credential.provider_id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${binding}`
}

type RefusedDelivery = Extract<NativeProviderDelivery, { projection: ProviderProjectionSource }>

function undeliverable(credential: CredentialMetadata, reason: string): RefusedDelivery {
  return {
    providerId: credential.provider_id,
    credentialId: credential.id,
    userId: credential.owner ?? null,
    projection: { unavailable: true, reason },
  }
}

function directFromDestination(credential: CredentialMetadata, destination: ProviderDestination): ProviderDirect {
  return {
    delivery: "direct",
    baseUrl: destination.origin,
    ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
    secret: destination.value,
    authKind: isSubscriptionKind(credential.kind) ? "subscription" : "api-key",
    ...(credential.expires_at ? { expiresAt: credential.expires_at } : {}),
    account: { credentialId: credential.id, providerId: credential.provider_id, ...(credential.label ? { label: credential.label } : {}) },
  }
}

function delivery(credential: CredentialMetadata, destination: ProviderDestination): NativeProviderDelivery {
  const providerId = credential.provider_id
  // A destination that also declares fixed companion headers — the ChatGPT
  // account id its backend reads to pick the plan — cannot be delivered
  // through an edge, which attaches one header per secret: a turn arriving
  // without the companion is refused by the vendor. Only a harness that sends
  // the companion itself can be handed such an account.
  if (destination.injection.headers) {
    if (!deliveredDirect(credential)) return undeliverable(credential, "native_delivery_needs_companion_header")
    return { providerId, credentialId: credential.id, userId: credential.owner ?? null, revision: credential.revision, direct: directFromDestination(credential, destination) }
  }
  const name = accountPlaceholderEnv(credential)
  // An exchanging vendor takes the stored key only at its exchange route and
  // answers with a short-lived access token the sandbox then sends itself. The
  // edge is scoped to that one request line, so every later request carries
  // the vendor's token untouched and the key never rides on it.
  const policy = destination.exchange
    ? { methods: [destination.exchange.method], pathPrefixes: [destination.exchange.path] }
    : { methods: destination.methods, pathPrefixes: destination.pathPrefixes }
  return {
    providerId,
    credentialId: credential.id,
    userId: credential.owner ?? null,
    revision: credential.revision,
    secret: {
      name,
      value: destination.value,
      hosts: [new URL(destination.origin).host],
      header: destination.injection.header,
      methods: policy.methods,
      pathPrefixes: policy.pathPrefixes,
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
 * The origin a stored account is delivered to, read from its row alone. A
 * sandbox is delivered one account per origin: the most recently marked one.
 */
export function deliveryOrigin(row: { provider_id: string; kind: CredentialKind }): string | undefined {
  return builtInProviderDestinationShape({ providerId: row.provider_id, kind: row.kind })?.origin
}

export type NativeCredentialSelection = { credential: CredentialMetadata; unavailable?: string }

type DeliveryWalk = {
  /** The sandbox's owner. */
  owner: string
  machineOwnerUserId: string
  selections: AccountSelections
  selected: readonly NativeCredentialSelection[]
  readSecret(credential: CredentialMetadata): Promise<string | null | undefined>
  /** The row to hand over, renewed first when it is a plan login close to expiring. */
  renew?(credential: CredentialMetadata): Promise<CredentialMetadata>
  destination?: (input: { providerId: string; kind: CredentialKind; secret: string }) => ProviderDestination | undefined
  secretReadFailure?: (credential: CredentialMetadata, error: unknown) => void
}

type WalkedAccount =
  | { refused: RefusedDelivery }
  | { credential: CredentialMetadata; destination: ProviderDestination }

/**
 * The accounts one person's runtime may spend, most recently marked first,
 * each resolved to its vendor destination or refused, and at most one account
 * per vendor host. Both delivery forms walk it, so they spend the same
 * accounts. `refusal` is the form's own reason to refuse an account before its
 * secret is read.
 */
async function walkDeliverableAccounts(
  input: DeliveryWalk,
  refusal: (credential: CredentialMetadata) => string | undefined,
): Promise<WalkedAccount[]> {
  const walked: WalkedAccount[] = []
  const claimed = new Map<string, string>()
  const holder = accountHolderOf(input.owner, input.machineOwnerUserId)
  const sources = holderAccountSources(input.selections, holder, input.machineOwnerUserId)
  const entitled = input.selected.filter(({ credential }) => spendsAccount(credential, holder, sources, input.machineOwnerUserId))
  for (const row of byMostRecentMark(entitled)) {
    const providerId = row.credential.provider_id
    const refused = row.unavailable ?? refusal(row.credential)
    if (refused) {
      walked.push({ refused: undeliverable(row.credential, refused) })
      continue
    }
    let credential = row.credential
    try {
      credential = await (input.renew?.(credential) ?? credential)
    } catch {
      walked.push({ refused: undeliverable(credential, "auth_failed") })
      continue
    }
    let secret: string | null | undefined
    try {
      secret = await input.readSecret(credential)
    } catch (error) {
      input.secretReadFailure?.(credential, error)
    }
    if (!secret) {
      walked.push({ refused: { ...undeliverable(credential, "unreadable_secret"), unreadable: true } })
      continue
    }
    const destination = (input.destination ?? builtInProviderDestination)({ providerId, kind: credential.kind, secret })
    if (!destination) {
      walked.push({ refused: undeliverable(credential, "no_destination") })
      continue
    }
    const holder = claimed.get(destination.origin)
    if (holder) {
      walked.push({ refused: undeliverable(credential,
        `duplicate_destination_host: ${new URL(destination.origin).host} is delivered for ${holder}, marked more recently`) })
      continue
    }
    claimed.set(destination.origin, providerId)
    walked.push({ credential, destination })
  }
  return walked
}

/**
 * What one person's sandbox is delivered: the account they chose for each
 * provider, their own or the org's. Nobody else's account reaches it, because
 * anything delivered can be spent by any code it runs.
 */
export async function nativeProviderDeliveriesFromRepository(input: DeliveryWalk & {
  secretBrokering?: SandboxSecretBrokering
}): Promise<NativeProviderDelivery[]> {
  const walked = await walkDeliverableAccounts(input, (credential) =>
    input.secretBrokering === "native" || deliveredDirect(credential) ? undefined : HARNESS_NEEDS_BROKERING)
  return walked.map((row) => "refused" in row ? row.refused : delivery(row.credential, row.destination))
}

/** One account handed to a harness that calls its vendor in process, or the reason it cannot be. */
export type DirectProviderDelivery = {
  providerId: string
  credentialId: string
  direct?: ProviderDirect
  unavailable?: string
}

/**
 * The same accounts as the native delivery, handed over as the secret itself
 * for a harness that calls the vendor from its own process. No provider edge
 * stands between, so a destination that needs a companion header is
 * deliverable: the harness reads the account from the token.
 */
export async function directProviderDeliveriesFromRepository(input: DeliveryWalk): Promise<DirectProviderDelivery[]> {
  const walked = await walkDeliverableAccounts(input, () => undefined)
  return walked.map((row) => {
    if ("refused" in row) {
      const reason = row.refused.projection
      return { providerId: row.refused.providerId, credentialId: row.refused.credentialId, unavailable: "reason" in reason ? reason.reason : "unavailable" }
    }
    const { credential, destination } = row
    return { providerId: credential.provider_id, credentialId: credential.id, direct: directFromDestination(credential, destination) }
  })
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

/** The marked accounts whose secret could not be read this time. */
export function unreadableDeliveries(deliveries: readonly NativeProviderDelivery[]): string[] {
  return deliveries.flatMap((row) => row.unreadable ? [row.credentialId] : [])
}

/**
 * The snapshot a sandbox runs on. Its machine owner is the sandbox's owner, so a
 * session with no person of its own spends their accounts, as it would on their
 * machine; it is never given a machine login there.
 */
export function nativeProviderAuth(
  deliveries: readonly NativeProviderDelivery[],
  input: { owner: string; machineOwnerUserId: string; selections: AccountSelections },
): CredentialSnapshot {
  const holder = accountHolderOf(input.owner, input.machineOwnerUserId)
  const selections = { [holder]: holderAccountSources(input.selections, holder, input.machineOwnerUserId) }
  const accounts = selectedAccounts<ProviderProjectionSource>({
    machineOwnerUserId: input.machineOwnerUserId,
    rows: deliveries.flatMap((row) => row.projection ? [{ owner: row.userId, providerId: row.providerId, projection: row.projection }] : []),
    selections,
    missingOrgAccount: () => ({ unavailable: true, reason: ORG_ACCOUNT_UNAVAILABLE }),
  })
  const handed = selectedAccounts<ProviderDirect | undefined>({
    machineOwnerUserId: input.machineOwnerUserId,
    rows: deliveries.flatMap((row) => row.direct ? [{ owner: row.userId, providerId: row.providerId, projection: row.direct }] : []),
    selections,
    missingOrgAccount: () => undefined,
  })
  const direct = Object.fromEntries(Object.entries(handed).flatMap(([user, rows]) => {
    const present = Object.entries(rows).flatMap(([providerId, row]) => row ? [[providerId, row] as const] : [])
    return present.length ? [[user, Object.fromEntries(present)]] : []
  }))
  return { machineOwnerUserId: holder, accounts, ...(Object.keys(direct).length ? { direct } : {}) }
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
 * The entries a digest names, each with the provider and account it installed
 * a secret for, so a caller holding one can tell which entries have changed.
 */
export function nativeDeliveryDigestEntries(
  digest: string,
): Array<{ providerId: string; credentialId: string; entry: string }> {
  if (!digest) return []
  return digest.split(DIGEST_SEPARATOR).flatMap((entry) => {
    const [providerId, credentialId] = entry.split(FIELD_SEPARATOR)
    return providerId && credentialId ? [{ providerId, credentialId, entry }] : []
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
