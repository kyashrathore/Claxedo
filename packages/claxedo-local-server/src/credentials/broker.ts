/**
 * The desktop's credential authority: the one place that turns registry rows
 * into bindings, mints the runtime identity those bindings belong to, and hands
 * the loopback broker its handler.
 *
 * A binding names a provider under a workspace, never an account: its id is a
 * hash of (org, workspace, provider), so its URL survives every account switch
 * and every rotation, and `resolve` reads whichever row carries the mark at
 * request time. The Cursor SDK freezes the URL at first import, so a URL that
 * moved with the account would send every later turn to a binding the
 * placeholder does not name. What moves instead is the lease generation: a
 * switch bumps it, refusing the placeholder minted for the previous account
 * until the next projection mints one for the new one.
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
import type { ProviderProjectionSource } from "@claxedo/workspace-runtime/config"
import {
  markCredentialUsed,
  readSecretById,
  activeCredentialsForScope,
  credentialById,
  updateCredentialHealth,
  SINGLE_TENANT_ORG,
} from "@claxedo/server-core/credentials/registry"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import {
  destinationAuthMode,
  hasProviderDestination,
  providerDestination,
  type ProviderDestination,
} from "@claxedo/server-core/credentials/destinations"
import {
  projectNativeProviderAuth,
  type SandboxSecretBrokering,
} from "@claxedo/server-core/credentials/native-delivery"

import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

const log = Log.create({ service: "credentials-broker" })

const BROKER_TOKEN_TTL_MS = 60 * 60 * 1000

/**
 * How long one vendor refusal counts towards the next.
 *
 * Two 401s a coffee break apart are two independent events, not a login going
 * bad; only a run of them inside a window says the account has actually stopped
 * working.
 */
const FAILURE_WINDOW_MS = 5 * 60 * 1000

/** Refusals before the broker alone takes the account off the provider. */
const FAILURES_BEFORE_YIELDING = 2

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
 * The counter every lease generation this machine issues comes from: one on
 * boot, one per account switch. Its stored value is the last one issued, so a
 * new process starts past every placeholder an earlier one minted.
 *
 * A missing or unreadable counter is an unknown generation, not the first one.
 * Restarting at 1 re-issues generations that placeholders minted before the
 * loss already name, and those validate again; a wall-clock start is past every
 * generation this machine can have reached by counting.
 */
function openGenerationCounter(dir: string) {
  const file = path.join(dir, "broker-generation")
  const stored = fs.existsSync(file) ? Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10) : Number.NaN
  let last = Number.isSafeInteger(stored) && stored > 0 ? stored : Date.now() - 1
  return function issue(): number {
    last += 1
    fs.writeFileSync(file, String(last), { mode: 0o600 })
    return last
  }
}

export type ProjectAuthInput = {
  scope?: SecretScope
  orgId?: string
  workspaceId?: string
  /** How the sandbox this projection is for can carry a credential, if at all. */
  secretBrokering?: SandboxSecretBrokering
}

export type LocalCredentialBroker = {
  /** Mounted at `/bindings/*` on the local server's own loopback origin. */
  handler: (request: Request) => Promise<Response>
  /** What the handler asks on every request; the registry answers it. */
  authority: BindingAuthority
  projectAuth: (input: ProjectAuthInput) => Promise<Record<string, ProviderProjectionSource>>
  /** The identity this server minted for a workspace, once it has projected one. */
  runtimeIdentity: (workspaceId: string, orgId?: string) => RuntimeIdentity
}

/** What a binding names, so a request resolves from its id alone. */
type MintedBinding = {
  providerId: string
  workspaceId: string
  orgId: string
  scope: SecretScope
  /** The row the placeholder now in the harness was minted for. */
  credentialId: string
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
  /** Leases moved past the boot generation by an account switch, by org and workspace. */
  const leaseGenerations = new Map<string, number>()

  /**
   * The key and generation counter, opened on first projection.
   *
   * A data directory this process cannot write is a fault on the operator's
   * machine, and opening it at construction would take the whole server down
   * with the credential authority. Opened here, the same fault reaches them as
   * a provider that says it is unavailable and why.
   */
  let opened: { signingKey: Uint8Array; bootGeneration: number; issueGeneration: () => number } | undefined
  function brokerState() {
    if (opened) return opened
    const dir = credentialsDir(input.dataDir)
    const issueGeneration = openGenerationCounter(dir)
    opened = { signingKey: loadSigningKey(dir), bootGeneration: issueGeneration(), issueGeneration }
    return opened
  }

  function leaseKey(orgId: string, workspaceId: string) {
    return `${orgId}\n${workspaceId}`
  }

  /**
   * `userId` is the single identity an unsigned local install has: the one
   * operator whose machine login this server already runs as. The org comes
   * from the caller rather than from this module, so a composition that
   * resolves a real tenant does not mint bindings in another one's name.
   */
  function runtimeIdentity(workspaceId: string, orgId = defaultOrg): RuntimeIdentity {
    const state = brokerState()
    return {
      userId: "operator",
      orgId,
      workspaceId,
      leaseId: `local:${workspaceId}`,
      leaseGeneration: leaseGenerations.get(leaseKey(orgId, workspaceId)) ?? state.bootGeneration,
      runtimeId: `embedded:${workspaceId}`,
    }
  }

  function bindingId(orgId: string, workspaceId: string, providerId: string) {
    return createHash("sha256").update(["operator", orgId, workspaceId, providerId].join(" ")).digest("hex").slice(0, 32)
  }

  /**
   * A placeholder is minted for one account and must not spend the next. The
   * binding's URL cannot change, so the lease moves on instead: every
   * placeholder the workspace holds names the old generation and is refused
   * until the next projection re-mints them.
   */
  function bindCurrentAccount(entry: MintedBinding, credential: CredentialMetadata) {
    if (entry.credentialId === credential.id) return false
    entry.credentialId = credential.id
    leaseGenerations.set(leaseKey(entry.orgId, entry.workspaceId), brokerState().issueGeneration())
    return true
  }

  /**
   * Every marked account, including one whose provider this broker has no
   * destination row for. Dropping those made an account the operator chose
   * indistinguishable from no account at all, and the harness answered that by
   * running on the machine's own login.
   */
  function selectedCredentials(scope: SecretScope, org: string) {
    return activeCredentialsForScope(scope, { onOutage: "throw" }, org)
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
    id: string,
    identity: RuntimeIdentity,
    credential: CredentialMetadata,
    destination: ProviderDestination,
  ): Binding {
    return {
      ...identity,
      id,
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

  /** Consecutive vendor refusals per credential, by the org its binding names. */
  const refusals = new Map<string, { revision: number; count: number; at: number }>()

  const authority: BindingAuthority = {
    /**
     * Resolves against whichever row carries the mark now, so a switch the
     * harness has not been re-projected for is caught here: the binding comes
     * back under the moved-on generation and the old placeholder is refused
     * rather than spending the account the operator just chose. Withdrawal
     * stops the running turn the same way — a revoked, expired or deleted
     * account is one the operator wants unspent now.
     */
    async resolve(id) {
      const entry = minted.get(id)
      if (!entry) return undefined
      const row = selectedCredentials(entry.scope, entry.orgId)
        .find((candidate) => candidate.credential.provider_id === entry.providerId)
      if (!row || row.unavailable) return undefined
      const destination = await destinationFor(row.credential, entry.orgId)
      if (!destination) return undefined
      const at = now()
      if (!bindCurrentAccount(entry, row.credential) && at - (usedAt.get(id) ?? 0) >= USE_MARK_INTERVAL_MS) {
        usedAt.set(id, at)
        markCredentialUsed(row.credential.id, at, entry.orgId)
      }
      return {
        binding: binding(id, runtimeIdentity(entry.workspaceId, entry.orgId), row.credential, destination),
        value: destination.value,
      }
    },
    async currentRuntime(identity) {
      return projected.has(leaseKey(identity.orgId, identity.workspaceId))
        && sameRuntime(runtimeIdentity(identity.workspaceId, identity.orgId), identity)
    },
    /**
     * One vendor 401 does not take an account off its provider.
     *
     * Marking on the first refusal means a single mid-turn hiccup moves the
     * mark to another account for good, and the operator never asked for that.
     * A second refusal on the same stored value, inside the window and with no
     * newer word from the provider in between, is the account having actually
     * stopped working — and that is what the operator's own Check says on its
     * first answer, because a Check is a question they chose to ask.
     */
    async reportFailure({ bindingId, credentialId, revision, status }) {
      // A 403 from a model vendor is a permission or region refusal, not a
      // rejected credential; marking on it would withdraw a working account.
      if (status !== 401) return
      // The org the binding was minted in. Read in the default one instead,
      // another tenant's row is never found and its 401 marks nothing.
      const org = minted.get(bindingId)?.orgId ?? defaultOrg
      const credential = credentialById(credentialId, { onOutage: "throw" }, org)
      // The revision the request used. A 401 for a value that has since been
      // rotated says nothing about the one stored now.
      if (!credential || credential.revision !== revision) return
      const at = now()
      const key = `${org}\n${credentialId}`
      const seen = refusals.get(key)
      // `>=`, not `>`: a Check and a refusal land in the same millisecond often
      // enough, and the safe reading of a tie is the one that keeps the account.
      const checkedSince = credential.last_validated_at !== null
        && credential.last_validated_at !== undefined
        && seen !== undefined
        && credential.last_validated_at >= seen.at
      const runs = seen !== undefined
        && seen.revision === revision
        && at - seen.at < FAILURE_WINDOW_MS
        && !checkedSince
      const count = runs ? seen.count + 1 : 1
      if (count < FAILURES_BEFORE_YIELDING) {
        refusals.set(key, { revision, count, at })
        log.info("Vendor refused a brokered credential once; waiting for a second before acting", {
          credential_id: credentialId,
          provider_id: credential.provider_id,
        })
        return
      }
      refusals.delete(key)
      updateCredentialHealth(credentialId, "auth_failed", at, org)
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
    async projectAuth({ scope = "local", orgId, workspaceId, secretBrokering }) {
      if (!workspaceId) return {}
      const org = orgId ?? defaultOrg
      // A shared-scope runtime is a sandbox this process cannot serve: its
      // requests never traverse this machine's loopback, so the credential
      // travels through its own provider's edge and the projection names the
      // variable that edge fills. Same authority, same selection, other
      // delivery.
      if (scope === "shared") {
        return await projectNativeProviderAuth({
          scope,
          orgId: org,
          ...(secretBrokering ? { secretBrokering } : {}),
        })
      }
      const selection = selectedCredentials(scope, org)
      const rows: Record<string, ProviderProjectionSource> = {}
      let state: { signingKey: Uint8Array }
      try {
        state = brokerState()
      } catch (error) {
        for (const { credential } of selection) {
          rows[credential.provider_id] = { unavailable: true, reason: `broker_unavailable: ${String(error)}` }
        }
        return rows
      }
      projected.add(leaseKey(org, workspaceId))
      const bindable: { id: string; credential: CredentialMetadata; destination: ProviderDestination }[] = []
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
        const id = bindingId(org, workspaceId, credential.provider_id)
        const entry = minted.get(id)
        if (entry) bindCurrentAccount(entry, credential)
        else minted.set(id, { providerId: credential.provider_id, workspaceId, orgId: org, scope, credentialId: credential.id })
        bindable.push({ id, credential, destination })
      }
      // Read after every switch above has moved the lease on, so one projection
      // mints every placeholder under the same generation.
      const identity = runtimeIdentity(workspaceId, org)
      const expiresAt = now() + BROKER_TOKEN_TTL_MS
      for (const { id, credential, destination } of bindable) {
        rows[credential.provider_id] = {
          baseUrl: bindingBaseUrl(input.brokerOrigin, id),
          placeholder: await mintRuntimeToken({ ...identity, bindingIds: [id], expiresAt }, state.signingKey, now()),
          authMode: destinationAuthMode(destination),
          expiresAt,
          ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
        }
      }
      return rows
    },
  }
}
