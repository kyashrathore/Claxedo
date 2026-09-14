import { base64UrlDecode, base64UrlEncode, sha256Hex } from "@claxedo/helpers/crypto"
import { describe, expect, test } from "vitest"
import {
  INVITATION_REDEEM_DOMAIN,
  INVITATION_TOKEN_PREFIX,
  MACHINE_NONCE_MAX_LENGTH,
  MACHINE_NONCE_MIN_LENGTH,
  MACHINE_NONCE_TTL_MS,
  MACHINE_REQUEST_DOMAIN,
  MACHINE_REQUEST_HEADERS,
  MACHINE_REQUEST_SKEW_MS,
  directoryWithinRoots,
  invitationRedeemPayload,
  invitationToken,
  invitationTokenParts,
  isMachineNonce,
  machineRequestPayload,
  normalizePosixDirectory,
  publicKeyFingerprint,
} from "./host-connect-contract"

// The host side (@claxedo/host-connector) pins these same literals in its own
// test; a change here without the matching change there fails enrollment.
describe("host connect contract literals", () => {
  test("machine request payload", () => {
    expect(machineRequestPayload({
      method: "post",
      pathname: "/api/claxedo/host/enrollments/heartbeat",
      bodySha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ts: 1_726_000_000_000,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      enrollmentId: "enr_abc",
    })).toBe(
      "claxedo.machine-request.v1\nPOST\n/api/claxedo/host/enrollments/heartbeat\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1726000000000\nAAAAAAAAAAAAAAAAAAAAAA\nenr_abc",
    )
    expect(MACHINE_REQUEST_DOMAIN).toBe("claxedo.machine-request.v1")
  })

  test("invitation redeem payload", () => {
    expect(invitationRedeemPayload({ invitationId: "inv_1", hostId: "host-a", publicKeySha256: "fp_x" })).toBe(
      "claxedo.host-enrollment.redeem.v1\ninvitation_id=inv_1\nhost_id=host-a\npublic_key_sha256=fp_x",
    )
    expect(INVITATION_REDEEM_DOMAIN).toBe("claxedo.host-enrollment.redeem.v1")
  })

  test("header names", () => {
    expect(MACHINE_REQUEST_HEADERS).toEqual({
      enrollmentId: "x-claxedo-enrollment-id",
      ts: "x-claxedo-host-ts",
      nonce: "x-claxedo-host-nonce",
      signature: "x-claxedo-host-signature",
    })
  })

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

describe("invitation token", () => {
  test("round-trips the frozen encoding", () => {
    expect(INVITATION_TOKEN_PREFIX).toBe("chx_inv_1")
    const token = invitationToken({ invitationId: "inv_AbC-_1", secret: "s3cr3t-_x" })
    expect(token).toBe("chx_inv_1.inv_AbC-_1.s3cr3t-_x")
    expect(invitationTokenParts(token)).toEqual({ invitationId: "inv_AbC-_1", secret: "s3cr3t-_x" })
  })

  test("refuses anything but three base64url parts under the prefix", () => {
    expect(invitationTokenParts("chx_inv_2.inv_1.secret")).toBeUndefined()
    expect(invitationTokenParts("chx_inv_1.inv_1")).toBeUndefined()
    expect(invitationTokenParts("chx_inv_1.inv_1.secret.extra")).toBeUndefined()
    expect(invitationTokenParts("chx_inv_1..secret")).toBeUndefined()
    expect(invitationTokenParts("chx_inv_1.inv_1.")).toBeUndefined()
    expect(invitationTokenParts("chx_inv_1.inv 1.secret")).toBeUndefined()
    expect(invitationTokenParts("chx_inv_1.inv_1.sec=ret")).toBeUndefined()
    expect(invitationTokenParts("")).toBeUndefined()
  })
})

describe("publicKeyFingerprint", () => {
  test("hashes the decoded x||y bytes, independent of JSON member order", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
    const x = base64UrlDecode(jwk.x!)
    const y = base64UrlDecode(jwk.y!)
    expect(x.byteLength).toBe(32)
    expect(y.byteLength).toBe(32)
    const material = new Uint8Array(64)
    material.set(x, 0)
    material.set(y, 32)
    const expected = base64UrlEncode(await crypto.subtle.digest("SHA-256", material))
    expect(await publicKeyFingerprint(jwk)).toBe(expected)
    expect(await publicKeyFingerprint({ y: jwk.y, x: jwk.x, crv: "P-256", kty: "EC", ext: true })).toBe(expected)
    expect(expected).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("pins the fingerprint of a fixed key", async () => {
    const jwk: JsonWebKey = {
      kty: "EC",
      crv: "P-256",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      y: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }
    // sha256 of 64 zero bytes
    expect(await publicKeyFingerprint(jwk)).toBe("9aX9QtFqIDAnmO9u0wmXm0MAPSMg2fDo6pgxqSdZ-0s")
  })

  test("refuses a non P-256 shape", async () => {
    await expect(publicKeyFingerprint({ kty: "RSA", n: "x", e: "AQAB" })).rejects.toThrow(TypeError)
    await expect(publicKeyFingerprint({ kty: "EC", crv: "P-256", x: "a+b", y: "AAAA" })).rejects.toThrow(TypeError)
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
