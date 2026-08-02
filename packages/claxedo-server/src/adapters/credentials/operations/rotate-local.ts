/**
 * KEK rotation for the LOCAL / self-host process.
 *
 * Node-only on purpose (SQLite + the process-selected backend), which is why it
 * is split from the worker-safe core in `rotate.ts`: `credentials/store.ts` and
 * `credentials/registry.ts` are both on the Worker's forbidden-import list.
 *
 * WHICH BACKEND THIS ACTUALLY SWEEPS. `getBackend()` picks the backend the
 * running process reads and writes through, and that is the one this rotates —
 * never a reconstructed one, so the sweep can never disagree with the live read
 * path:
 *
 *  - `CLAXEDO_CF_KV_URL` set → envelope-encrypted Cloudflare KV under a single
 *    deployment partition (`CLAXEDO_CREDENTIALS_ORG_ID`, default "deployment").
 *    This is the self-host-on-KV posture and it IS KEK-managed, so the drain
 *    applies in full.
 *  - otherwise → the local encrypted file store (`credentials/local.ts`). That
 *    store is OUTSIDE the KEK scheme entirely: it encrypts with a machine-local
 *    key derived from `~/.claxedo/credentials/.seed`, carries no key-id, and
 *    has no `CLAXEDO_CREDENTIALS_KEK` involvement. There is therefore nothing
 *    for a KEK rotation to re-encrypt, and the report says so explicitly
 *    (`envelopeManaged: false`) rather than reporting a hollow success.
 *
 * ENUMERATION. Two sources, unioned, because neither alone is complete:
 *  - every `secure_ref` in `claxedo_provider_credential` (ACROSS ALL org rows —
 *    the SQL `org_id` column partitions tenants in metadata and is a different
 *    axis from the envelope's HKDF partition, which is fixed per deployment
 *    here);
 *  - when the store is KV-backed, the KV key listing as well, which also
 *    catches ciphertext orphaned by a metadata row that was deleted while the
 *    backend delete failed. Orphans are unreachable but still decryptable under
 *    the old KEK, so they count against retiring it.
 */

import { ClaxedoDB } from "../../../platform/db/db"
import { ClaxedoProviderCredentialTable } from "../../../platform/db/provider-credential.sql"
import { getBackend } from "../store"
import { isEnvelopeBackend } from "../backends/envelope"
import { listCloudflareCredentialRefs } from "../backends/cloudflare"
import {
  rotateEnvelopeKeys,
  type EnvelopeRotationEntry,
  type EnvelopeRotationReport,
} from "./rotate"
import { Log } from "../../../platform/runtime/lib/log"

const log = Log.create({ service: "credentials-rotate-local" })

export type LocalEnvelopeRotationReport = EnvelopeRotationReport & {
  /**
   * False when the active backend is the local file store, which is not part
   * of the KEK scheme at all. `complete` is then trivially true: no ciphertext
   * anywhere is bound to `CLAXEDO_CREDENTIALS_KEK`.
   */
  envelopeManaged: boolean
  /** The envelope (HKDF) partition the local process writes under. */
  partition: string
}

/** The envelope partition `credentials/store.ts` composes its KV backend with. */
export function localEnvelopePartition(env: Record<string, string | undefined> = process.env): string {
  return env.CLAXEDO_CREDENTIALS_ORG_ID?.trim() || "deployment"
}

/** Every backend ref reachable from credential metadata, de-duplicated. */
function refsFromRegistry(): string[] {
  const rows = ClaxedoDB.use((db) =>
    db.select({ secure_ref: ClaxedoProviderCredentialTable.secure_ref }).from(ClaxedoProviderCredentialTable).all(),
  )
  return [...new Set(rows.map((row) => row.secure_ref?.trim()).filter((ref): ref is string => !!ref))]
}

/**
 * Re-encrypt every locally stored credential under the current KEK.
 *
 * Pass `dryRun: true` to answer "is any ciphertext still under the old key-id?"
 * without writing — the check that gates removing the retired KEK.
 */
export async function rotateLocalCredentialKeys(opts: {
  dryRun?: boolean
  env?: Record<string, string | undefined>
  onEntry?: (entry: EnvelopeRotationEntry) => void
} = {}): Promise<LocalEnvelopeRotationReport> {
  const env = opts.env ?? process.env
  const partition = localEnvelopePartition(env)
  const backend = getBackend()

  if (!isEnvelopeBackend(backend)) {
    log.info("Local credential store is not KEK-managed — nothing to rotate", { partition })
    return {
      dryRun: opts.dryRun === true,
      currentKeyId: "",
      scanned: 0,
      alreadyCurrent: 0,
      rewritten: 0,
      pending: 0,
      absent: 0,
      staleKeyIds: [],
      failures: [],
      entries: [],
      complete: true,
      envelopeManaged: false,
      partition,
    }
  }

  const refs = new Set(refsFromRegistry())
  if (env.CLAXEDO_CF_KV_URL?.trim()) {
    for (const ref of await listCloudflareCredentialRefs({ env })) refs.add(ref)
  }

  const report = await rotateEnvelopeKeys({
    items: [...refs].sort().map((ref) => ({ ref, orgId: partition })),
    backendFor: () => backend,
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
    ...(opts.onEntry ? { onEntry: opts.onEntry } : {}),
  })

  return { ...report, envelopeManaged: true, partition }
}
