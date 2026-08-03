import { describe, expect, test, afterAll, beforeEach } from "vitest"
import { realpathSync, mkdirSync, existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

/**
 * FILE-SCOPE env override, deliberately.
 *
 * This suite writes to and deletes from the credential store. A per-`describe`
 * setup/teardown would restore `CLAXEDO_DATA_DIR` while later blocks were still
 * running and point those writes and deletions at the DEVELOPER'S REAL
 * `~/.claxedo` store. The override is therefore established once, before any
 * module that resolves a path is imported, and torn down exactly once at the
 * very end — and `the store path is inside the temp dir` below asserts the
 * resolution actually landed in the sandbox before anything else runs.
 */
const root = path.join(realpathSync(os.tmpdir()), `cred-rotate-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prevDataDir = process.env.CLAXEDO_DATA_DIR
const prevPartition = process.env.CLAXEDO_CREDENTIALS_ORG_ID
process.env.CLAXEDO_DATA_DIR = root
delete process.env.CLAXEDO_CREDENTIALS_ORG_ID

const { dataDir } = await import("../../platform/runtime/lib/paths")
const { setBackendOverride } = await import("../backend-registry")
const { putCredential, listCredentials, deleteCredential } = await import("../registry")
const { createStaticKeyProvider, encryptedSecretBackend, envelopeKeyId } = await import("../envelope")
const { rotateLocalCredentialKeys, localEnvelopePartition } = await import("./rotate-local")
const { ClaxedoDB } = await import("../../platform/db/db")
const { ClaxedoProviderCredentialTable } = await import("../provider-credential.sql")
ClaxedoDB.Drizzle()

import type { SecretBackend } from "../types"

function kek(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

function byteStore(): SecretBackend & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async put(id, secret) {
      const ref = `test:${id}`
      values.set(ref, secret)
      return ref
    },
    async get(ref) {
      return values.get(ref) ?? null
    },
    async delete(ref) {
      values.delete(ref)
    },
    async probe() {
      return true
    },
  }
}

const PARTITION = "deployment"

/** The store as it was BEFORE the rotation: only the key being retired exists. */
function oldEpoch(inner: SecretBackend) {
  return encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: PARTITION })
}

/** The store DURING the rotation: new key current, retired key still accepted. */
function rotatedEpoch(inner: SecretBackend) {
  return encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2), previous: [kek(1)] }), {
    orgId: PARTITION,
  })
}

function clearCredentialRows() {
  ClaxedoDB.use((db) => db.delete(ClaxedoProviderCredentialTable).run())
}

describe("local credential store KEK rotation", () => {
  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prevDataDir
    if (prevPartition === undefined) delete process.env.CLAXEDO_CREDENTIALS_ORG_ID
    else process.env.CLAXEDO_CREDENTIALS_ORG_ID = prevPartition
  })

  beforeEach(() => {
    clearCredentialRows()
  })

  test("SAFETY PIN: the resolved store path is inside this test's temp dir, never ~/.claxedo", () => {
    const resolved = realpathSync(dataDir())
    expect(resolved).toBe(root)
    expect(resolved.startsWith(realpathSync(os.tmpdir()))).toBe(true)
    expect(resolved).not.toContain(path.join(os.homedir(), ".claxedo"))
    // Filesystem proof, not just a resolved string: the SQLite file this suite
    // reads and deletes credential rows from actually materialized in the
    // sandbox. If the override ever fails to take, this fails BEFORE any test
    // writes a row.
    expect(existsSync(path.join(root, "claxedo.db"))).toBe(true)
  })

  test("drains every registry-reachable credential onto the current KEK, then verifies clean", async () => {
    const inner = byteStore()
    setBackendOverride(oldEpoch(inner))
    await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-openai" })
    await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-anthropic" })

    const retired = await envelopeKeyId(kek(1))
    const active = await envelopeKeyId(kek(2))
    for (const stored of inner.values.values()) expect(stored.split(":")[1]).toBe(retired)

    setBackendOverride(rotatedEpoch(inner))

    const audit = await rotateLocalCredentialKeys({ dryRun: true })
    expect(audit.envelopeManaged).toBe(true)
    expect(audit.partition).toBe(PARTITION)
    expect(audit.scanned).toBe(2)
    expect(audit.pending).toBe(2)
    expect(audit.staleKeyIds).toEqual([retired])
    expect(audit.complete).toBe(false)

    const report = await rotateLocalCredentialKeys()
    expect(report.rewritten).toBe(2)
    expect(report.failures).toEqual([])
    expect(report.complete).toBe(true)
    for (const stored of inner.values.values()) expect(stored.split(":")[1]).toBe(active)

    const after = await rotateLocalCredentialKeys({ dryRun: true })
    expect(after.pending).toBe(0)
    expect(after.alreadyCurrent).toBe(2)
    expect(after.staleKeyIds).toEqual([])
    expect(after.complete).toBe(true)

    // The retired KEK can now genuinely leave configuration.
    const newKeyOnly = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(2) }), {
      orgId: PARTITION,
    })
    const refs = listCredentials().map((credential) => credential.secure_ref!)
    expect((await Promise.all(refs.map((ref) => newKeyOnly.get(ref)))).sort()).toEqual([
      "sk-anthropic",
      "sk-openai",
    ])
  })

  test("idempotent: a second pass over a drained store rewrites nothing", async () => {
    const inner = byteStore()
    setBackendOverride(oldEpoch(inner))
    await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-openai" })
    setBackendOverride(rotatedEpoch(inner))

    expect((await rotateLocalCredentialKeys()).rewritten).toBe(1)
    const snapshot = new Map(inner.values)

    const second = await rotateLocalCredentialKeys()
    expect(second.rewritten).toBe(0)
    expect(second.alreadyCurrent).toBe(1)
    expect(second.complete).toBe(true)
    expect([...inner.values]).toEqual([...snapshot])
  })

  test("an undecryptable credential is reported loudly and does not abort the sweep", async () => {
    const inner = byteStore()
    setBackendOverride(oldEpoch(inner))
    await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-openai" })

    // A credential written under a KEK this deployment no longer configures.
    setBackendOverride(
      encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(9) }), { orgId: PARTITION }),
    )
    await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-anthropic" })

    setBackendOverride(rotatedEpoch(inner))
    const report = await rotateLocalCredentialKeys()

    expect(report.scanned).toBe(2)
    expect(report.rewritten).toBe(1)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]!.error).toMatch(/unknown key-id/)
    expect(report.complete).toBe(false)

    const orphanRef = listCredentials().find((credential) => credential.provider_id === "anthropic")!.secure_ref!
    expect(report.failures[0]!.ref).toBe(orphanRef)
  })

  test("reports honestly when the active backend is not KEK-managed at all", async () => {
    const inner = byteStore()
    // A plain SecretBackend with no envelope wrapper — the local file store's shape.
    setBackendOverride(inner)
    await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-openai" })

    const report = await rotateLocalCredentialKeys()
    expect(report.envelopeManaged).toBe(false)
    expect(report.scanned).toBe(0)
    // Nothing anywhere is bound to a KEK, so no KEK is holding anything hostage.
    expect(report.complete).toBe(true)
    expect(report.staleKeyIds).toEqual([])
  })

  test("a row deleted after enumeration is absent, not a lost credential", async () => {
    const inner = byteStore()
    setBackendOverride(oldEpoch(inner))
    const credential = await putCredential({
      provider_id: "openai",
      kind: "api_key",
      source: "managed",
      secret: "sk-openai",
    })
    setBackendOverride(rotatedEpoch(inner))
    // Metadata row survives, bytes are gone (the reverse of an orphan).
    inner.values.delete(credential.secure_ref!)

    const report = await rotateLocalCredentialKeys()
    expect(report.absent).toBe(1)
    expect(report.failures).toEqual([])
    expect(report.complete).toBe(true)

    await deleteCredential(credential.id)
  })

  test("the deployment partition is the one credentials/store.ts composes with", () => {
    expect(localEnvelopePartition({})).toBe("deployment")
    expect(localEnvelopePartition({ CLAXEDO_CREDENTIALS_ORG_ID: "  acme  " })).toBe("acme")
  })
})
