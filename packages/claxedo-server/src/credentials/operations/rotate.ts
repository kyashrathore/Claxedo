/**
 * KEK rotation — the re-encryption drain that makes retiring a key REAL.
 *
 * `credentials/envelope.ts` prefixes every ciphertext with the key-id it was
 * written under and accepts a second KEK for reads
 * (`CLAXEDO_CREDENTIALS_KEK_NEXT`), so "rotate" has so far meant only "new
 * writes use the new key". That never retires anything: every value written
 * before the rotation still decrypts ONLY under the old KEK, so the old KEK has
 * to stay in configuration forever — which is precisely the state rotation
 * exists to escape when a key is suspected compromised.
 *
 * This module is the missing half. It sweeps stored ciphertext, re-encrypts
 * each value under the CURRENT KEK, and reports whether anything is left under
 * a retired key-id — the one question that gates removing the old KEK.
 *
 * SAFETY PROPERTIES
 *
 * - Idempotent. Each slot is classified by its stored key-id BEFORE any work;
 *   a slot already under the current key-id is left untouched, so a second run
 *   over a finished store rewrites nothing.
 * - Resumable / crash-safe. A slot is rewritten by ONE overwrite of its own
 *   storage id, with no intermediate state anywhere: crash before the write and
 *   the old ciphertext is intact and still decryptable (the old KEK is still
 *   configured — it must be, or the drain could not have started); crash after
 *   it and the slot is simply already current. There is no window in which a
 *   credential is lost or half-written, and the re-run picks up exactly what is
 *   left. The write is also asserted to land on the SAME ref it came from, so a
 *   scheme drift fails loudly and the unexpected ref is removed best-effort
 *   instead of silently duplicating a secret into a new slot.
 * - Fails closed PER ITEM, never per batch. One undecryptable, foreign, or
 *   tampered slot is recorded as a failure and the sweep continues — but it is
 *   surfaced in `failures`, counted, and forces `complete: false`, so it can
 *   never be mistaken for "done".
 * - Never widens access. Re-encryption goes through the ordinary envelope
 *   `get`/`put` pair, so plaintext exists only in memory for the moment of the
 *   rewrite and the inner byte store still only ever sees `cenc1` envelopes.
 *
 * VERIFYING COMPLETION: run with `dryRun: true` (or `auditEnvelopeKeys`). It
 * classifies every slot without writing and reports `staleKeyIds` — the
 * distinct non-current key-ids that still hold ciphertext. `complete: true`
 * with an empty `staleKeyIds` and no failures is the evidence needed to drop
 * the retired KEK from configuration.
 */

import { credentialIdFromRef, type EnvelopeAdmin } from "../envelope"
import { listCloudflareCredentialRefs, createEncryptedCloudflareBackend } from "../backends/cloudflare"
import type { SecretBackend } from "../types"
import { Log } from "../../platform/runtime/lib/log"

const log = Log.create({ service: "credentials-rotate" })

type EnvLike = Record<string, string | undefined>

/** A backend that can be swept: the secret API plus the key-id inspector. */
export type RotatableBackend = SecretBackend & EnvelopeAdmin

export type EnvelopeRotationOutcome =
  /** Already under the active key-id — nothing to do (this is what makes re-runs no-ops). */
  | "already_current"
  /** Decrypted under a retired key-id and re-written under the active one. */
  | "rewritten"
  /** Dry run only: stale, and would be rewritten by a real pass. */
  | "pending"
  /** Nothing stored here any more (deleted between enumeration and sweep). */
  | "absent"
  /** Could not be classified, read, re-encrypted, or verified. Never silent. */
  | "failed"

export type EnvelopeRotationEntry = {
  ref: string
  /** Envelope (HKDF) partition the slot was swept under. */
  orgId: string
  outcome: EnvelopeRotationOutcome
  /** Key-id found in storage, when the slot was a well-formed envelope. */
  fromKeyId?: string
  /** Key-id the slot carries after the pass. */
  toKeyId?: string
  error?: string
}

export type EnvelopeRotationReport = {
  dryRun: boolean
  /** The key-id every slot must end up under. */
  currentKeyId: string
  scanned: number
  alreadyCurrent: number
  rewritten: number
  /** Dry run only: slots a real pass would rewrite. */
  pending: number
  absent: number
  /**
   * Non-current key-ids that STILL hold ciphertext after the pass. Non-empty
   * means the matching KEK cannot be removed from configuration yet.
   */
  staleKeyIds: string[]
  failures: EnvelopeRotationEntry[]
  entries: EnvelopeRotationEntry[]
  /**
   * True only when nothing failed and nothing remains under a retired key-id —
   * i.e. every KEK other than the active one is now safe to un-configure.
   */
  complete: boolean
}

export type EnvelopeRotationItem = {
  ref: string
  /**
   * Envelope partition. Ciphertext is bound to a per-org HKDF subkey, so the
   * sweep MUST use the same partition the value was written under or GCM
   * authentication fails.
   */
  orgId: string
}

function emptyReport(currentKeyId: string, dryRun: boolean): EnvelopeRotationReport {
  return {
    dryRun,
    currentKeyId,
    scanned: 0,
    alreadyCurrent: 0,
    rewritten: 0,
    pending: 0,
    absent: 0,
    staleKeyIds: [],
    failures: [],
    entries: [],
    complete: true,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Sweep every supplied slot onto the current KEK.
 *
 * `backendFor` is called once per distinct `orgId` and the result cached, so a
 * hosted sweep across many tenants derives each per-org subkey once.
 */
export async function rotateEnvelopeKeys(input: {
  items: Iterable<EnvelopeRotationItem> | AsyncIterable<EnvelopeRotationItem>
  backendFor: (orgId: string) => RotatableBackend | Promise<RotatableBackend>
  /** Classify only — write nothing. This is the completion check. */
  dryRun?: boolean
  /** Best-effort progress observer. Its failures never alter or abort the sweep. */
  onEntry?: (entry: EnvelopeRotationEntry) => void
}): Promise<EnvelopeRotationReport> {
  const dryRun = input.dryRun === true
  const backends = new Map<string, Promise<RotatableBackend>>()
  const backendFor = (orgId: string) => {
    const cached = backends.get(orgId)
    if (cached) return cached
    const pending = (async () => input.backendFor(orgId))()
    backends.set(orgId, pending)
    return pending
  }

  let currentKeyId: string | undefined
  const report = emptyReport("", dryRun)
  const stale = new Set<string>()

  const record = (entry: EnvelopeRotationEntry) => {
    report.entries.push(entry)
    report.scanned += 1
    if (entry.outcome === "failed") report.failures.push(entry)
    else if (entry.outcome === "already_current") report.alreadyCurrent += 1
    else if (entry.outcome === "rewritten") report.rewritten += 1
    else if (entry.outcome === "pending") report.pending += 1
    else if (entry.outcome === "absent") report.absent += 1
    try {
      input.onEntry?.(entry)
    } catch (error) {
      log.warn("Credential KEK rotation observer failed", {
        ref: entry.ref,
        org_id: entry.orgId,
        error: describe(error),
      })
    }
  }

  for await (const item of input.items as AsyncIterable<EnvelopeRotationItem>) {
    const orgId = item.orgId?.trim()
    if (!orgId) {
      record({
        ref: item.ref,
        orgId: "",
        outcome: "failed",
        error:
          "no envelope partition (orgId) could be resolved for this ref — it cannot be decrypted without one; supply an explicit partition resolver",
      })
      continue
    }

    let staleKeyId: string | undefined
    try {
      const backend = await backendFor(orgId)
      currentKeyId ??= await backend.currentKeyId()
      const current = currentKeyId

      const state = await backend.inspect(item.ref)
      if (state.state === "absent") {
        record({ ref: item.ref, orgId, outcome: "absent" })
        continue
      }
      if (state.state === "foreign") {
        stale.add("<not-an-envelope>")
        record({
          ref: item.ref,
          orgId,
          outcome: "failed",
          error:
            "stored value is not a cenc1 envelope (legacy plaintext, foreign format, or corruption) — it cannot be re-encrypted and reads of it already fail closed",
        })
        continue
      }
      if (state.keyId === current) {
        record({ ref: item.ref, orgId, outcome: "already_current", fromKeyId: current, toKeyId: current })
        continue
      }
      staleKeyId = state.keyId
      if (dryRun) {
        stale.add(state.keyId)
        record({ ref: item.ref, orgId, outcome: "pending", fromKeyId: state.keyId })
        continue
      }

      // Decrypt under whichever accepted key-id the slot carries. Throws (fail
      // closed) when that KEK is not configured or authentication fails.
      const plaintext = await backend.get(item.ref)
      if (plaintext === null) {
        record({ ref: item.ref, orgId, outcome: "absent", fromKeyId: state.keyId })
        continue
      }

      // ONE overwrite of the same slot: no temp key, no delete, nothing to
      // reconcile if the process dies mid-pass.
      const writtenRef = await backend.put(credentialIdFromRef(item.ref), plaintext)
      if (writtenRef !== item.ref) {
        await backend.delete(writtenRef).catch((error) => {
          log.warn("Failed to clean up alternate credential ref after rotation scheme drift", {
            ref: item.ref,
            alternate_ref: writtenRef,
            error: describe(error),
          })
        })
        stale.add(state.keyId)
        record({
          ref: item.ref,
          orgId,
          outcome: "failed",
          fromKeyId: state.keyId,
          error: `re-encrypted value landed on "${writtenRef}" instead of its own slot — backend ref scheme drift; refusing to treat this slot as rotated`,
        })
        continue
      }

      const after = await backend.inspect(item.ref)
      if (after.state !== "envelope" || after.keyId !== current) {
        stale.add(state.keyId)
        record({
          ref: item.ref,
          orgId,
          outcome: "failed",
          fromKeyId: state.keyId,
          error: `slot did not end up under the current key-id after rewrite (found ${after.state === "envelope" ? after.keyId : after.state})`,
        })
        continue
      }

      record({ ref: item.ref, orgId, outcome: "rewritten", fromKeyId: state.keyId, toKeyId: current })
    } catch (error) {
      if (staleKeyId) stale.add(staleKeyId)
      record({ ref: item.ref, orgId, outcome: "failed", fromKeyId: staleKeyId, error: describe(error) })
    }
  }

  report.currentKeyId = currentKeyId ?? ""
  report.staleKeyIds = [...stale].sort()
  report.complete = report.failures.length === 0 && report.staleKeyIds.length === 0

  log[report.complete ? "info" : "warn"]("Credential KEK rotation pass finished", {
    dry_run: dryRun,
    current_key_id: report.currentKeyId,
    scanned: report.scanned,
    rewritten: report.rewritten,
    already_current: report.alreadyCurrent,
    pending: report.pending,
    absent: report.absent,
    failures: report.failures.length,
    stale_key_ids: report.staleKeyIds.join(",") || "none",
    complete: report.complete,
  })

  return report
}

/**
 * The completion check: "is any ciphertext still under a retired key-id?".
 * Writes nothing. `complete: true` is the evidence that the old KEK can be
 * removed from configuration.
 */
export function auditEnvelopeKeys(
  input: Omit<Parameters<typeof rotateEnvelopeKeys>[0], "dryRun">,
): Promise<EnvelopeRotationReport> {
  return rotateEnvelopeKeys({ ...input, dryRun: true })
}

/**
 * The envelope partition a hosted KV ref belongs to.
 *
 * `hostedOrgCredentials` writes under `cf:org/<orgId>/credential/<providerId>`
 * (worker-credentials.ts), and that org segment is the ONLY record of which
 * HKDF subkey the value was encrypted under — KV itself has no tenant column.
 * Returns undefined for a ref that does not carry one, so the caller reports it
 * rather than guessing a partition and producing an authentication failure.
 */
export function hostedCredentialOrgFromRef(ref: string): string | undefined {
  const match = /^cf:org\/([^/]+)\/credential\//.exec(ref)
  return match?.[1]
}

/**
 * Rotate the HOSTED (Cloudflare KV) credential store.
 *
 * Enumerates via the KV key listing — the only directory the hosted store has —
 * and re-encrypts each value under its own org's subkey derived from the
 * current KEK.
 */
export async function rotateHostedCredentialKeys(opts: {
  env?: EnvLike
  dryRun?: boolean
  /** Partition resolver override for refs that do not carry an org segment. */
  orgIdFor?: (ref: string) => string | undefined
  onEntry?: (entry: EnvelopeRotationEntry) => void
} = {}): Promise<EnvelopeRotationReport> {
  const env = opts.env ?? process.env
  const resolveOrg = opts.orgIdFor ?? hostedCredentialOrgFromRef
  // No `fetch` override here on purpose: the KV BYTE store this rotates always
  // uses the global `fetch`, so an override that reached only the key listing
  // would look like a transport seam while half the traffic ignored it.
  const refs = await listCloudflareCredentialRefs({ env })

  return rotateEnvelopeKeys({
    items: refs.map((ref) => ({ ref, orgId: resolveOrg(ref) ?? "" })),
    backendFor: (orgId) => createEncryptedCloudflareBackend({ orgId, env }),
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
    ...(opts.onEntry ? { onEntry: opts.onEntry } : {}),
  })
}
