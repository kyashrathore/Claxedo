import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash, randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `cred-store-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, getBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { createLocalBackend } = await import("@claxedo/server-core/credentials/backends/local")

describe("credential store", () => {
  afterAll(async () => {
    setBackendOverride(undefined)
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  describe("test backend", () => {
    test("put and get round-trip", async () => {
      const backend = createTestBackend()
      const ref = await backend.put("test-id", "my-secret")
      expect(ref).toBe("test:test-id")
      expect(await backend.get(ref)).toBe("my-secret")
    })

    test("delete removes secret", async () => {
      const backend = createTestBackend()
      const ref = await backend.put("del-id", "delete-me")
      await backend.delete(ref)
      expect(await backend.get(ref)).toBeNull()
    })

    test("get returns null for unknown ref", async () => {
      const backend = createTestBackend()
      expect(await backend.get("test:unknown")).toBeNull()
    })

    test("probe always returns true", async () => {
      const backend = createTestBackend()
      expect(await backend.probe()).toBe(true)
    })
  })

  describe("local backend", () => {
    test("encrypts and decrypts round-trip", async () => {
      const backend = createLocalBackend()
      const ref = await backend.put("local-test", "secret-data-123")
      expect(ref).toBe("local:local-test")

      const resolved = await backend.get(ref)
      expect(resolved).toBe("secret-data-123")
    })

    test("replaces encrypted secret files atomically without temp leftovers", async () => {
      const backend = createLocalBackend()
      const ref = await backend.put("local-atomic", "first")
      await backend.put("local-atomic", "second")

      expect(await backend.get(ref)).toBe("second")
      const files = await fs.readdir(path.join(root, "credentials"))
      const secretFile = `${createHash("sha256").update(ref).digest("hex")}.enc`
      expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([])
      expect(files).toContain(secretFile)
    })

    test("delete removes encrypted file", async () => {
      const backend = createLocalBackend()
      const ref = await backend.put("local-del", "remove-me")
      await backend.delete(ref)
      expect(await backend.get(ref)).toBeNull()
    })

    test("get returns null for unknown ref", async () => {
      const backend = createLocalBackend()
      expect(await backend.get("local:nonexistent")).toBeNull()
    })

    test("reports encrypted-store corruption instead of treating it as absence", async () => {
      const backend = createLocalBackend()
      const ref = await backend.put("local-corrupt", "secret")
      await fs.writeFile(
        path.join(root, "credentials", `${createHash("sha256").update(ref).digest("hex")}.enc`),
        "not-an-encrypted-secret",
      )

      await expect(backend.get(ref)).rejects.toThrow()
    })

    test("reports deletion failures instead of claiming the secret is gone", async () => {
      const backend = createLocalBackend()
      const ref = await backend.put("local-delete-error", "secret")
      const secretFile = path.join(root, "credentials", `${createHash("sha256").update(ref).digest("hex")}.enc`)
      await fs.unlink(secretFile)
      await fs.mkdir(secretFile)

      await expect(backend.delete(ref)).rejects.toThrow()
      await fs.rmdir(secretFile)
    })

    test("probe succeeds", async () => {
      const backend = createLocalBackend()
      expect(await backend.probe()).toBe(true)
    })
  })

  describe("backend selection", () => {
    test("defaults to local backend when CLAXEDO_CF_KV_URL is not set", () => {
      delete process.env.CLAXEDO_CF_KV_URL
      setBackendOverride(undefined)
      const backend = getBackend()
      expect(backend).toBeTruthy()
    })

    test("override takes precedence", async () => {
      const test = createTestBackend()
      setBackendOverride(test)
      const backend = getBackend()
      const ref = await backend.put("override-test", "val")
      expect(ref).toBe("test:override-test")
      setBackendOverride(undefined)
    })
  })
})
