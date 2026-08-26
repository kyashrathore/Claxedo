/**
 * One-writer migration orchestration (Unit 6).
 *
 * Sequencing exists to make two failure modes impossible rather than unlikely:
 *
 *   - Two writers on one SQLite file. The legacy writer must be closed and
 *     PROVEN closed before anything reads or copies it.
 *   - A half-migrated database being served. The import lands in a separate
 *     staging file that is only promoted to the canonical path after semantic
 *     validation passes, and promotion is a single atomic rename.
 *
 * Readiness never comes from `migration.v1.status`. On Node that resolves to a
 * no-op reporting `{ status: "completed" }` without moving anything
 * (contract doc §6.2), so trusting it would admit traffic to an empty
 * database. Semantic validation is the only authority here.
 *
 * A failure preserves the source and the backup and reports the phase it
 * failed in. It never launches the old engine and never deletes the source.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  expectationFor,
  toV2Transfer,
  validateImported,
  type LegacyTransferEnvelope,
  type TransferExpectation,
  type ValidationFailure,
} from "./transfer"

export type MigrationPhase =
  | "quiesce"
  | "backup"
  | "export"
  | "manifest"
  | "import"
  | "validate"
  | "promote"
  | "complete"

export class MigrationError extends Error {
  readonly code = "opencode_migration_failed"
  constructor(readonly phase: MigrationPhase, message: string, options?: { cause?: unknown }) {
    super(`OpenCode migration failed during ${phase}: ${message}`)
    this.name = "MigrationError"
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** Checksummed record of what checkpoint 6a exported. */
export type TransferManifest = Readonly<{
  version: 1
  createdAt: number
  /** Digest of the legacy database at backup time. */
  sourceDigest: string
  sessions: readonly TransferExpectation[]
  /** Archive state lifted out of the SDK payload; Claxedo's ledger. */
  archived: Readonly<Record<string, number>>
}>

export function digestFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/**
 * Build the manifest from exported envelopes.
 *
 * Sealing is refused rather than guessed at when the corpus is internally
 * inconsistent — a duplicate session id means the export is untrustworthy and
 * a later "did everything arrive?" check would silently pass.
 */
export function sealManifest(
  envelopes: readonly LegacyTransferEnvelope[],
  input: { sourceDigest: string; createdAt: number },
): TransferManifest {
  const sessions: TransferExpectation[] = []
  const archived: Record<string, number> = {}
  const seen = new Set<string>()

  for (const envelope of envelopes) {
    const expectation = expectationFor(envelope)
    if (seen.has(expectation.id)) {
      throw new MigrationError("manifest", `duplicate session id in export: ${expectation.id}`)
    }
    seen.add(expectation.id)
    sessions.push(expectation)
    if (expectation.archivedAt !== undefined) archived[expectation.id] = expectation.archivedAt
  }

  return { version: 1, createdAt: input.createdAt, sourceDigest: input.sourceDigest, sessions, archived }
}

/**
 * Copy the legacy database consistently.
 *
 * Copying a live main file without its WAL loses committed transactions, so
 * the caller must have closed the writer first; `assertQuiesced` is how that
 * is proven. Sidecars are copied when present so a restore is byte-faithful.
 */
export function backupDatabase(source: string, destination: string): string {
  if (!fs.existsSync(source)) throw new MigrationError("backup", `legacy database ${source} does not exist`)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, destination + suffix)
  }
  const digest = digestFile(destination)
  if (digest !== digestFile(source)) {
    throw new MigrationError("backup", "backup digest does not match source; the writer was not quiesced")
  }
  // Least-privilege: conversations and tokens live in here.
  fs.chmodSync(destination, 0o600)
  return digest
}

/**
 * Prove the legacy writer is closed before anything touches its file.
 *
 * A live WAL is the observable symptom of an open writer. This is deliberately
 * conservative: refusing to migrate is always recoverable, migrating under a
 * second writer is not.
 */
export function assertQuiesced(source: string): void {
  const wal = `${source}-wal`
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    throw new MigrationError("quiesce", "legacy database still has a non-empty WAL; its writer is not closed")
  }
}

export type ImportedSession = Readonly<{
  id: string
  parentID?: string
  title?: string
  messageCount: number
}>

/**
 * Compare the staged database against the manifest.
 *
 * Both directions matter: a missing session is data loss, and an unexpected
 * one means the staging file was not created fresh.
 */
export function validateAgainstManifest(
  manifest: TransferManifest,
  imported: readonly ImportedSession[],
): readonly ValidationFailure[] {
  const byId = new Map(imported.map((row) => [row.id, row]))
  const failures: ValidationFailure[] = []

  for (const expected of manifest.sessions) {
    const actual = byId.get(expected.id)
    if (!actual) {
      failures.push({ id: expected.id, field: "presence", expected: "imported", actual: "missing" })
      continue
    }
    failures.push(...validateImported(expected, actual))
    byId.delete(expected.id)
  }

  for (const [id] of byId) {
    failures.push({ id, field: "presence", expected: "absent", actual: "unexpected session in staging database" })
  }

  return failures
}

/**
 * Atomically publish the staged database.
 *
 * `rename` within a filesystem is atomic, so a crash mid-promotion leaves
 * either the old file or the new one — never a partially written canonical
 * database. The previous file is kept aside rather than deleted.
 */
export function promote(staging: string, canonical: string): void {
  if (!fs.existsSync(staging)) throw new MigrationError("promote", `staging database ${staging} does not exist`)
  if (fs.existsSync(canonical)) {
    fs.renameSync(canonical, `${canonical}.superseded`)
  }
  fs.renameSync(staging, canonical)
}

/** Payloads ready for `sessions.import`, in manifest order. */
export function importPayloads(envelopes: readonly LegacyTransferEnvelope[]) {
  return envelopes.map((envelope) => toV2Transfer(envelope).payload)
}
