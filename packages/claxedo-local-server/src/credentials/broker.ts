/**
 * The desktop's credential authority: the one place that turns registry rows
 * into bindings, mints the runtime identity those bindings belong to, and hands
 * the loopback broker its handler.
 *
 * A binding is derived, never stored. Its id is a hash of the runtime identity
 * and the credential id, so the same row under the same runtime always names the
 * same binding, and `resolve` reads the row's current secret at request time —
 * which makes a rotation an ordinary registry write with nothing else to notify.
 * The local server process holds the value; the harness process never does.
 */

import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  bindingBaseUrl,
  createEgressBroker,
  mintRuntimeToken,
  sameRuntime,
  verifyRuntimeToken,
  type Binding,
  type BindingAuthority,
  type RuntimeIdentity,
} from "@claxedo/egress-broker"
import type { ProviderProjection } from "@claxedo/workspace-runtime/config"
import {
  credentialUnavailableForScope,
  markCredentialUsed,
  readSecretById,
  requireActiveCredentialsForScope,
  requireCredential,
  updateCredentialHealth,
  SINGLE_TENANT_ORG,
} from "@claxedo/server-core/credentials/registry"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { hasProviderDestination, providerDestination, type ProviderDestination } from "./destinations"

export const BROKER_TOKEN_TTL_MS = 60 * 60 * 1000

/** The window a brokered request re-marks the row it spent, at most once within. */
const USE_MARK_INTERVAL_MS = 60 * 1000

type SecretScope = "local" | "shared"

function credentialsDir(dataDir: string) {
  const dir = path.join(dataDir, "credentials")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `mkdirSync` applies its mode only when it creates the directory, so a
  // directory that already existed — or one an umask widened — still holds the
  // signing key at whatever mode it had.
  if (fs.statSync(dir).mode & 0o077) fs.chmodSync(dir, 0o700)
  return dir
}

function loadSigningKey(dir: string): Uint8Array {
  const file = path.join(dir, "broker.key")
  const existing = fs.existsSync(file) ? fs.readFileSync(file) : undefined
  if (existing) {
    // A truncated file is a damaged key, not an absent one. Writing over it
    // would invalidate every placeholder already in a harness and turn a
    // repairable state into turns that fail authentication for no visible
    // reason.
    if (existing.byteLength < 32) throw new Error(`Broker signing key at ${file} is shorter than 32 bytes`)
    if (fs.statSync(file).mode & 0o177) fs.chmodSync(file, 0o600)
    return new Uint8Array(existing)
  }
  const key = randomBytes(32)
  fs.writeFileSync(file, key, { mode: 0o600 })
  return new Uint8Array(key)
}

/**
 * A local workspace has no lease, so the boot counter is what makes one runtime
 * generation newer than the last: every placeholder a previous process minted
 * names a generation this one no longer answers for.
 *
 * A missing or unreadable counter is an unknown generation, not the first one.
 * Restarting at 1 re-issues generations that placeholders minted before the
 * loss already name, and those validate again; a wall-clock start is past every
 * generation this machine can have reached by counting.
 */
function nextLeaseGeneration(dir: string): number {
  const file = path.join(dir, "broker-generation")
  const stored = fs.existsSync(file) ? Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10) : Number.NaN
  const next = Number.isSafeInteger(stored) && stored > 0 ? stored + 1 : Date.now()
  fs.writeFileSync(file, String(next), { mode: 0o600 })
  return next
}

export type ProjectAuthInput = {
  scope?: SecretScope
  orgId?: string
  workspaceId?: string
}

export type LocalCredentialBroker = {
  /** Mounted at `/bindings/*` on the local server's own loopback origin. */
  handler: (request: Request) => Promise<Response>
  /** What the handler asks on every request; the registry answers it. */
  authority: BindingAuthority
  projectAuth: (input: ProjectAuthInput) => Promise<Record<string, ProviderProjection>>
  /** The identity this server minted for a workspace, once it has projected one. */
  runtimeIdentity: (workspaceId: string, orgId?: string) => RuntimeIdentity
}

/** What a binding was minted against, so a request resolves from its id alone. */
type MintedBinding = {
  credentialId: string
  workspaceId: string
  orgId: string
  scope: SecretScope
}

export function createLocalCredentialBroker(input: {
  dataDir: string
  /** This server's own loopback origin; the broker is a route on it, never a second listener. */
  brokerOrigin: string
  /** The org a caller that names none is answered in. */
  org?: string
  now?: () => number
}): LocalCredentialBroker {
  const defaultOrg = input.org ?? SINGLE_TENANT_ORG
  const now = input.now ?? Date.now
  const minted = new Map<string, MintedBinding>()
  const projected = new Set<string>()
  const usedAt = new Map<string, number>()

  /**
   * The key and generation, opened on first projection.
   *
   * A data directory this process cannot write is a fault on the operator's
   * machine, and opening it at construction would take the whole server down
   * with the credential authority. Opened here, the same fault reaches them as
   * a provider that says it is unavailable and why.
   */
  let opened: { signingKey: Uint8Array; leaseGeneration: number } | undefined
  function brokerState() {
    if (opened) return opened
    try {
      const dir = credentialsDir(input.dataDir)
      opened = { signingKey: loadSigningKey(dir), leaseGeneration: nextLeaseGeneration(dir) }
      return opened
    } catch (error) {
      // Not remembered: the fault is the operator's to fix, and a broker that
      // holds the first failure for the life of the process leaves every
      // account unavailable until the server is restarted.
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * `userId` is the single identity an unsigned local install has: the one
   * operator whose machine login this server already runs as. The org comes
   * from the caller rather than from this module, so a composition that
   * resolves a real tenant does not mint bindings in another one's name.
   */
  function runtimeIdentity(workspaceId: string, orgId = defaultOrg): RuntimeIdentity {
    return {
      userId: "operator",
      orgId,
      workspaceId,
      leaseId: `local:${workspaceId}`,
      leaseGeneration: brokerState().leaseGeneration,
      runtimeId: `embedded:${workspaceId}`,
    }
  }

  function bindingId(identity: RuntimeIdentity, credentialId: string) {
    return createHash("sha256").update([
      identity.userId,
      identity.orgId,
      identity.workspaceId,
      identity.leaseId,
      String(identity.leaseGeneration),
      identity.runtimeId,
      credentialId,
    ].join(" ")).digest("hex").slice(0, 32)
  }

  /**
   * Every marked account, including one whose provider this broker has no
   * destination row for. Dropping those made an account the operator chose
   * indistinguishable from no account at all, and the harness answered that by
   * running on the machine's own login.
   */
  function selectedCredentials(scope: SecretScope, org: string) {
    return requireActiveCredentialsForScope(scope, org)
      .map((row) => hasProviderDestination(row.credential.provider_id)
        ? row
        : { credential: row.credential, unavailable: row.unavailable ?? "no_destination" })
  }

  /**
   * The destination a usable row currently binds to, read from its live secret
   * so a rotation that changes the account's form also changes its vendor host.
   */
  async function destinationFor(credential: CredentialMetadata, org: string) {
    const secret = await readSecretById(credential.id, org)
    if (!secret) return undefined
    return providerDestination({ providerId: credential.provider_id, kind: credential.kind, secret })
  }

  function binding(
    identity: RuntimeIdentity,
    credential: CredentialMetadata,
    destination: ProviderDestination,
  ): Binding {
    return {
      ...identity,
      id: bindingId(identity, credential.id),
      credentialId: credential.id,
      revision: credential.revision,
      status: "active",
      destination: {
        origin: destination.origin,
        methods: destination.methods,
        pathPrefixes: destination.pathPrefixes,
      },
      injection: destination.injection,
    }
  }

  /**
   * A turn outlives the operator's choice of account. Re-marking one account
   * while another is mid-turn must not kill that turn, so a request resolves
   * against the credential its own binding names rather than against whichever
   * row currently carries the mark; the next projection is what moves the
   * harness onto the new account. Withdrawal still stops the running turn — a
   * revoked, expired or deleted account is one the operator wants unspent now.
   */
  const authority: BindingAuthority = {
    async resolve(id) {
      const entry = minted.get(id)
      if (!entry) return undefined
      const credential = requireCredential(entry.credentialId, entry.orgId)
      if (!credential || credentialUnavailableForScope(credential, entry.scope)) return undefined
      const destination = await destinationFor(credential, entry.orgId)
      if (!destination) return undefined
      const at = now()
      if (at - (usedAt.get(id) ?? 0) >= USE_MARK_INTERVAL_MS) {
        usedAt.set(id, at)
        markCredentialUsed(credential.id, at, entry.orgId)
      }
      return {
        binding: binding(runtimeIdentity(entry.workspaceId, entry.orgId), credential, destination),
        value: destination.value,
      }
    },
    async currentRuntime(identity) {
      return projected.has(`${identity.orgId}\n${identity.workspaceId}`)
        && sameRuntime(runtimeIdentity(identity.workspaceId, identity.orgId), identity)
    },
    async reportFailure({ bindingId, credentialId, revision, status }) {
      // A 403 from a model vendor is a permission or region refusal, not a
      // rejected credential; marking on it would withdraw a working account.
      if (status !== 401) return
      // The org the binding was minted in. Read in the default one instead,
      // another tenant's row is never found and its 401 marks nothing.
      const org = minted.get(bindingId)?.orgId ?? defaultOrg
      const credential = requireCredential(credentialId, org)
      // The revision the request used. A 401 for a value that has since been
      // rotated says nothing about the one stored now.
      if (!credential || credential.revision !== revision) return
      updateCredentialHealth(credentialId, "auth_failed", now(), org)
    },
  }

  const handler = createEgressBroker({
    authority,
    // A key this process cannot open leaves every token unverifiable, which is
    // what a 401 says. Which key is missing, and why, reaches the operator
    // through the projection instead.
    verifyToken: async (token) => {
      try {
        return await verifyRuntimeToken(token, brokerState().signingKey)
      } catch {
        return undefined
      }
    },
  })

  return {
    handler,
    authority,
    runtimeIdentity,
    async projectAuth({ scope = "local", orgId, workspaceId }) {
      if (!workspaceId) return {}
      const org = orgId ?? defaultOrg
      const selection = selectedCredentials(scope, org)
      const rows: Record<string, ProviderProjection> = {}
      let state: { signingKey: Uint8Array; leaseGeneration: number }
      try {
        state = brokerState()
      } catch (error) {
        for (const { credential } of selection) {
          rows[credential.provider_id] = { unavailable: true, reason: `broker_unavailable: ${String(error)}` }
        }
        return rows
      }
      projected.add(`${org}\n${workspaceId}`)
      const identity = runtimeIdentity(workspaceId, org)
      const expiresAt = now() + BROKER_TOKEN_TTL_MS
      for (const { credential, unavailable } of selection) {
        // A marked account that cannot be bound is reported, never dropped: the
        // harness has to refuse the turn rather than run on the machine's login.
        if (unavailable) {
          rows[credential.provider_id] = { unavailable: true, reason: unavailable }
          continue
        }
        const destination = await destinationFor(credential, org)
        if (!destination) {
          rows[credential.provider_id] = { unavailable: true, reason: "unreadable_secret" }
          continue
        }
        const id = bindingId(identity, credential.id)
        minted.set(id, { credentialId: credential.id, workspaceId, orgId: org, scope })
        rows[credential.provider_id] = {
          baseUrl: bindingBaseUrl(input.brokerOrigin, id),
          placeholder: await mintRuntimeToken({ ...identity, bindingIds: [id], expiresAt }, state.signingKey, now()),
          authMode: destination.injection.header.toLowerCase() === "authorization" ? "bearer" : "api-key",
          expiresAt,
          ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
        }
      }
      return rows
    },
  }
}
