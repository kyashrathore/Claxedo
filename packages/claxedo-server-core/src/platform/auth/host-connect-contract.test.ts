import { sha256Hex } from "@claxedo/helpers/crypto"
import { describe, expect, test } from "vitest"
import {
  MACHINE_NONCE_MAX_LENGTH,
  MACHINE_NONCE_MIN_LENGTH,
  MACHINE_NONCE_TTL_MS,
  MACHINE_REQUEST_SKEW_MS,
  directoryWithinRoots,
  isMachineNonce,
  normalizePosixDirectory,
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

describe("normalizePosixDirectory", () => {
  test("collapses dot segments, repeats and trailing slashes", () => {
    expect(normalizePosixDirectory("/srv/api/")).toBe("/srv/api")
    expect(normalizePosixDirectory("/srv//api/./v1/../v2")).toBe("/srv/api/v2")
    expect(normalizePosixDirectory("/")).toBe("/")
    expect(normalizePosixDirectory("///")).toBe("/")
    expect(normalizePosixDirectory("/srv/..")).toBe("/")
    expect(normalizePosixDirectory("/../../etc")).toBe("/etc")
  })

  test("refuses relative and empty paths", () => {
    expect(normalizePosixDirectory("")).toBeUndefined()
    expect(normalizePosixDirectory("srv/api")).toBeUndefined()
    expect(normalizePosixDirectory("./srv")).toBeUndefined()
    expect(normalizePosixDirectory("~/srv")).toBeUndefined()
    expect(normalizePosixDirectory("C:\\srv")).toBeUndefined()
  })
})

describe("normalizeStoredDirectory", () => {
  test("stores the normalized POSIX form and any other shape verbatim", () => {
    expect(normalizeStoredDirectory("/srv/app/")).toBe("/srv/app")
    expect(normalizeStoredDirectory("/srv/app/./x/../y")).toBe("/srv/app/y")
    expect(normalizeStoredDirectory("C:\\srv\\app")).toBe("C:\\srv\\app")
    expect(normalizeStoredDirectory("")).toBe("")
  })
})

describe("directoryWithinRoots", () => {
  const roots = ["/srv", "/home/alice/projects/"]

  test("segment-aware containment", () => {
    expect(directoryWithinRoots("/srv", roots)).toBe(true)
    expect(directoryWithinRoots("/srv/", roots)).toBe(true)
    expect(directoryWithinRoots("/srv/api", roots)).toBe(true)
    expect(directoryWithinRoots("/srv/api/deep/er", roots)).toBe(true)
    expect(directoryWithinRoots("/home/alice/projects/x", roots)).toBe(true)
    expect(directoryWithinRoots("/srvx", roots)).toBe(false)
    expect(directoryWithinRoots("/srvx/api", roots)).toBe(false)
    expect(directoryWithinRoots("/home/alice", roots)).toBe(false)
    expect(directoryWithinRoots("/", roots)).toBe(false)
  })

  test("dot segments are collapsed before comparing", () => {
    expect(directoryWithinRoots("/srv/api/../../etc", roots)).toBe(false)
    expect(directoryWithinRoots("/srv/../srv/api", roots)).toBe(true)
    expect(directoryWithinRoots("/tmp/../srv/api", roots)).toBe(true)
    expect(directoryWithinRoots("/srv/./api", roots)).toBe(true)
  })

  test("relative directories, empty roots and non-absolute roots admit nothing", () => {
    expect(directoryWithinRoots("srv/api", roots)).toBe(false)
    expect(directoryWithinRoots("/srv/api", [])).toBe(false)
    expect(directoryWithinRoots("/srv/api", ["srv"])).toBe(false)
    expect(directoryWithinRoots("/srv/api", [""])).toBe(false)
  })

  test("a root of / admits every absolute path", () => {
    expect(directoryWithinRoots("/anything/at/all", ["/"])).toBe(true)
    expect(directoryWithinRoots("/", ["/"])).toBe(true)
    expect(directoryWithinRoots("relative", ["/"])).toBe(false)
  })
})
