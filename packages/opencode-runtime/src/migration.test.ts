import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  assertQuiesced,
  backupDatabase,
  digestFile,
  MigrationError,
  promote,
  sealManifest,
  validateAgainstManifest,
  type ImportedSession,
} from "./migration"
import type { LegacyTransferEnvelope } from "./transfer"

const roots: string[] = []

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-migration-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function envelope(id: string, overrides: Partial<LegacyTransferEnvelope["info"]> = {}, messages: unknown[] = []): LegacyTransferEnvelope {
  return {
    info: {
      id,
      projectID: "proj",
      title: `session ${id}`,
      location: { directory: "/tmp/ws" },
      time: { created: 1, updated: 2 },
      ...overrides,
    },
    messages,
  }
}

test("refuses to migrate while the legacy writer is still open", () => {
  const root = tempRoot()
  const db = path.join(root, "opencode.db")
  fs.writeFileSync(db, "data")
  fs.writeFileSync(`${db}-wal`, "uncommitted")
  // A non-empty WAL is the observable symptom of a live writer. Refusing is
  // always recoverable; migrating under two writers is not.
  expect(() => assertQuiesced(db)).toThrow(MigrationError)

  fs.writeFileSync(`${db}-wal`, "")
  expect(() => assertQuiesced(db)).not.toThrow()
})

test("backup is byte-faithful, carries sidecars, and is not world-readable", () => {
  const root = tempRoot()
  const db = path.join(root, "opencode.db")
  fs.writeFileSync(db, "legacy contents")
  fs.writeFileSync(`${db}-wal`, "")
  const backup = path.join(root, "backup", "opencode.db")

  const digest = backupDatabase(db, backup)
  expect(digest).toBe(digestFile(db))
  expect(fs.readFileSync(backup, "utf8")).toBe("legacy contents")
  expect(fs.existsSync(`${backup}-wal`)).toBe(true)
  // Conversations and tokens live in here.
  expect(fs.statSync(backup).mode & 0o077).toBe(0)
})

test("backup of a missing source fails in the backup phase", () => {
  const root = tempRoot()
  try {
    backupDatabase(path.join(root, "absent.db"), path.join(root, "b.db"))
    throw new Error("expected a MigrationError")
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError)
    expect((error as MigrationError).phase).toBe("backup")
  }
})

test("sealing refuses a corpus with a duplicate session id", () => {
  expect(() => sealManifest([envelope("ses_a"), envelope("ses_a")], { sourceDigest: "d", createdAt: 1 })).toThrow(
    /duplicate session id/,
  )
})

test("the manifest carries archive state as a Claxedo ledger, not SDK payload", () => {
  const manifest = sealManifest(
    [envelope("ses_a"), envelope("ses_b", { time: { created: 1, updated: 2, archived: 999 } })],
    { sourceDigest: "digest", createdAt: 42 },
  )
  expect(manifest.archived).toEqual({ ses_b: 999 })
  expect(manifest.sessions.map((s) => s.id).sort()).toEqual(["ses_a", "ses_b"])
})

test("validation catches a missing session as data loss", () => {
  const manifest = sealManifest([envelope("ses_a"), envelope("ses_b")], { sourceDigest: "d", createdAt: 1 })
  const imported: ImportedSession[] = [{ id: "ses_a", title: "session ses_a", messageCount: 0 }]
  const failures = validateAgainstManifest(manifest, imported)
  expect(failures).toHaveLength(1)
  expect(failures[0]).toMatchObject({ id: "ses_b", field: "presence", actual: "missing" })
})

test("validation catches an unexpected session as a dirty staging database", () => {
  const manifest = sealManifest([envelope("ses_a")], { sourceDigest: "d", createdAt: 1 })
  const imported: ImportedSession[] = [
    { id: "ses_a", title: "session ses_a", messageCount: 0 },
    { id: "ses_stowaway", title: "?", messageCount: 0 },
  ]
  const failures = validateAgainstManifest(manifest, imported)
  expect(failures).toHaveLength(1)
  expect(failures[0]!.id).toBe("ses_stowaway")
})

test("validation catches a semantic mismatch, not just presence", () => {
  const manifest = sealManifest([envelope("ses_a", { parentID: "ses_parent" }, [1, 2, 3])], {
    sourceDigest: "d",
    createdAt: 1,
  })
  const failures = validateAgainstManifest(manifest, [
    { id: "ses_a", parentID: undefined, title: "session ses_a", messageCount: 3 },
  ])
  expect(failures.map((f) => f.field)).toEqual(["parentID"])
})

test("a clean import validates with no failures", () => {
  const manifest = sealManifest([envelope("ses_a", { parentID: "p" }, [1, 2])], { sourceDigest: "d", createdAt: 1 })
  expect(
    validateAgainstManifest(manifest, [{ id: "ses_a", parentID: "p", title: "session ses_a", messageCount: 2 }]),
  ).toEqual([])
})

test("promotion is atomic and keeps the superseded database", () => {
  const root = tempRoot()
  const staging = path.join(root, "staging.db")
  const canonical = path.join(root, "opencode.db")
  fs.writeFileSync(canonical, "old")
  fs.writeFileSync(staging, "new")

  promote(staging, canonical)

  expect(fs.readFileSync(canonical, "utf8")).toBe("new")
  // The previous database is kept aside, never deleted.
  expect(fs.readFileSync(`${canonical}.superseded`, "utf8")).toBe("old")
  expect(fs.existsSync(staging)).toBe(false)
})

test("promotion of a missing staging database fails in the promote phase", () => {
  const root = tempRoot()
  try {
    promote(path.join(root, "absent.db"), path.join(root, "opencode.db"))
    throw new Error("expected a MigrationError")
  } catch (error) {
    expect((error as MigrationError).phase).toBe("promote")
  }
})
