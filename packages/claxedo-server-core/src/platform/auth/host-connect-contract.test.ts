import { sha256Hex } from "@claxedo/helpers/crypto"
import { describe, expect, test } from "vitest"
import {
  MACHINE_NONCE_MAX_LENGTH,
  MACHINE_NONCE_MIN_LENGTH,
  MACHINE_NONCE_TTL_MS,
  MACHINE_REQUEST_SKEW_MS,
  isMachineNonce,
  normalizeStoredDirectory,
} from "./host-connect-contract"

describe("host connect contract", () => {
  test("windows and nonce bounds", () => {
    expect(MACHINE_REQUEST_SKEW_MS).toBe(60_000)
    expect(MACHINE_NONCE_TTL_MS).toBe(120_000)
    expect(MACHINE_NONCE_MIN_LENGTH).toBe(16)
    expect(MACHINE_NONCE_MAX_LENGTH).toBe(64)
    expect(isMachineNonce("a".repeat(15))).toBe(false)
    expect(isMachineNonce("a".repeat(16))).toBe(true)
    expect(isMachineNonce("a".repeat(64))).toBe(true)
    expect(isMachineNonce("a".repeat(65))).toBe(false)
    expect(isMachineNonce("a".repeat(15) + "+")).toBe(false)
    expect(isMachineNonce("a".repeat(15) + "=")).toBe(false)
  })

  test("empty body hashes to the SHA-256 of zero bytes", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

describe("normalizeStoredDirectory", () => {
  test("stores the normalized form of either kind of absolute path, and any other shape verbatim", () => {
    expect(normalizeStoredDirectory("/srv/app/")).toBe("/srv/app")
    expect(normalizeStoredDirectory("/srv/app/./x/../y")).toBe("/srv/app/y")
    expect(normalizeStoredDirectory("c:/work/app/")).toBe("C:\\work\\app")
    expect(normalizeStoredDirectory("C:\\work\\.\\app")).toBe("C:\\work\\app")
    expect(normalizeStoredDirectory("\\\\server\\share\\app\\")).toBe("\\\\server\\share\\app")
    expect(normalizeStoredDirectory("srv/app")).toBe("srv/app")
    expect(normalizeStoredDirectory("")).toBe("")
  })
})
