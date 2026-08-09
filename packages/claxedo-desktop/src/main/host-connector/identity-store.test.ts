import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SafeStorageApi } from "../account/credential-store"
import {
  loadHostConnectorIdentity,
  machineIdentityFile,
  storeHostConnectorIdentity,
  type MachineIdentityFile,
} from "./identity-store"

const identity = {
  hostId: "host_test",
  privateKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "private" } satisfies JsonWebKey,
}

function safeStorage(overrides: Partial<SafeStorageApi> = {}) {
  const encrypted: string[] = []
  const api: SafeStorageApi = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      encrypted.push(plain)
      return Buffer.from(JSON.stringify({ sealed: plain }))
    },
    decryptString: (value) => {
      const parsed = JSON.parse(value.toString("utf8")) as { sealed?: string }
      if (typeof parsed.sealed !== "string") throw new Error("not sealed")
      return parsed.sealed
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
  }
  return { api, encrypted }
}

function memoryFile(initial?: string) {
  let contents = initial
  let clears = 0
  const file: MachineIdentityFile = {
    read: () => contents,
    write: (next) => {
      contents = next
    },
    clear: () => {
      contents = undefined
      clears++
    },
  }
  return { file, contents: () => contents, clears: () => clears }
}

describe("the canonical encrypted identity record", () => {
  test("round-trips the child bootstrap identity through safeStorage", () => {
    const storage = safeStorage()
    const disk = memoryFile()

    expect(
      storeHostConnectorIdentity({ safeStorage: storage.api, file: disk.file, platform: "darwin", identity }),
    ).toEqual({ ok: true })
    expect(loadHostConnectorIdentity({ safeStorage: storage.api, file: disk.file, platform: "darwin" })).toEqual({
      ok: true,
      identity,
    })
    expect(JSON.parse(disk.contents()!)).toEqual({
      backend: "gnome_libsecret",
      ciphertext: expect.any(String),
    })
    expect(storage.encrypted).toHaveLength(1)
    expect(JSON.parse(storage.encrypted[0]!)).toEqual(identity)
    expect(disk.contents()).not.toContain("private")
  })

  test("an absent record is distinct from an unusable secure store", () => {
    const disk = memoryFile()
    const secure = safeStorage()
    const unavailable = safeStorage({ isEncryptionAvailable: () => false })

    expect(loadHostConnectorIdentity({ safeStorage: secure.api, file: disk.file, platform: "darwin" })).toEqual({ ok: true })
    expect(loadHostConnectorIdentity({ safeStorage: unavailable.api, file: disk.file, platform: "darwin" })).toMatchObject({
      ok: false,
      reason: "no-secure-storage",
    })
  })

  test("rejects Linux basic_text before reading or writing secret material", () => {
    const storage = safeStorage({ getSelectedStorageBackend: () => "basic_text" })
    const disk = memoryFile()

    expect(
      storeHostConnectorIdentity({ safeStorage: storage.api, file: disk.file, platform: "linux", identity }),
    ).toMatchObject({ ok: false, reason: "no-secure-storage" })
    expect(loadHostConnectorIdentity({ safeStorage: storage.api, file: disk.file, platform: "linux" })).toMatchObject({
      ok: false,
      reason: "no-secure-storage",
    })
    expect(storage.encrypted).toEqual([])
    expect(disk.contents()).toBeUndefined()
  })

  test("clears corrupt, backend-changed, and incomplete records", () => {
    const storage = safeStorage()
    const cases = [
      "not-json",
      JSON.stringify({ backend: "kwallet6", ciphertext: "x" }),
      JSON.stringify({ backend: "gnome_libsecret", ciphertext: Buffer.from("garbage").toString("base64") }),
      JSON.stringify({
        backend: "gnome_libsecret",
        ciphertext: Buffer.from(JSON.stringify({ sealed: JSON.stringify({ hostId: "host_x" }) })).toString("base64"),
      }),
    ]

    for (const contents of cases) {
      const disk = memoryFile(contents)
      const rejected: string[] = []
      expect(
        loadHostConnectorIdentity({
          safeStorage: storage.api,
          file: disk.file,
          platform: "linux",
          onRejected: (reason) => rejected.push(reason),
        }),
      ).toEqual({ ok: true })
      expect(disk.contents()).toBeUndefined()
      expect(disk.clears()).toBe(1)
      expect(rejected).toHaveLength(1)
    }
  })
})

describe("the per-profile file", () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  function directory() {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-host-identity-"))
    dirs.push(dir)
    return dir
  }

  test("uses a separate owner-only file from the account credential", () => {
    const dir = directory()
    const file = machineIdentityFile(dir)
    file.write("record")

    expect(readFileSync(join(dir, "host-machine-identity.json"), "utf8")).toBe("record")
    expect(() => readFileSync(join(dir, "account-credential.json"), "utf8")).toThrow()
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "host-machine-identity.json")).mode & 0o777).toBe(0o600)
    }
    file.clear()
    expect(file.read()).toBeUndefined()
  })

  test("two profile directories do not share a record", () => {
    const first = machineIdentityFile(directory())
    const second = machineIdentityFile(directory())
    first.write("first")
    second.write("second")

    expect(first.read()).toBe("first")
    expect(second.read()).toBe("second")
  })
})
