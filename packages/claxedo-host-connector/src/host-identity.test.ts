import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto"
import { describe, expect, test } from "vitest"

import {
  createHostKeyPair,
  hostKeyPairFromJwk,
  hostMachineRequestPayload,
  machineRequestSignature,
  newHostId,
  randomNonce,
  hostSha256Hex,
} from "./host-identity"
import {
  MACHINE_REQUEST_HEADERS,
  invitationRedeemPayload,
  publicKeyFingerprint,
} from "@claxedo/account-contract/machine"

describe("machine request payload", () => {
  test("is the seven-line P1.1 literal", async () => {
    const payload = await hostMachineRequestPayload({
      method: "post",
      pathname: "/api/claxedo/host/enrollments/heartbeat",
      bodyText: '{"enrollmentId":"enr_1"}',
      ts: 1_700_000_000_000,
      nonce: "abcdefghijklmnop",
      enrollmentId: "enr_1",
    })

    expect(payload).toBe(
      [
        "claxedo.machine-request.v1",
        "POST",
        "/api/claxedo/host/enrollments/heartbeat",
        createHash("sha256").update('{"enrollmentId":"enr_1"}').digest("hex"),
        "1700000000000",
        "abcdefghijklmnop",
        "enr_1",
      ].join("\n"),
    )
  })

  test("hashes an empty body as sha256 of nothing", async () => {
    expect(await hostSha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  })

  test("signs the payload with the machine key in P1363 form the control plane can verify", async () => {
    const keys = await createHostKeyPair()
    const input = {
      method: "POST",
      pathname: "/api/claxedo/host/enrollments/acquire",
      bodyText: "{}",
      ts: 1,
      nonce: "0123456789abcdef",
      enrollmentId: "enr_2",
    }

    const signature = await machineRequestSignature(keys, input)

    const verified = nodeVerify(
      "sha256",
      Buffer.from(await hostMachineRequestPayload(input)),
      { key: createPublicKey({ key: JSON.parse(keys.publicKey), format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    )
    expect(verified).toBe(true)
  })

  test("names the four headers the verifier reads", () => {
    expect(MACHINE_REQUEST_HEADERS).toEqual({
      enrollmentId: "x-claxedo-enrollment-id",
      ts: "x-claxedo-host-ts",
      nonce: "x-claxedo-host-nonce",
      signature: "x-claxedo-host-signature",
    })
  })

  test("a nonce is 43 base64url characters, fresh each time", () => {
    const nonces = new Set([randomNonce(), randomNonce(), randomNonce()])
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(nonces.size).toBe(3)
  })
})

describe("invitation redeem payload", () => {
  test("is the four-line P1.3 literal", () => {
    expect(invitationRedeemPayload({ invitationId: "inv_1", hostId: "host_a", publicKeySha256: "FP" })).toBe(
      "claxedo.host-enrollment.redeem.v1\ninvitation_id=inv_1\nhost_id=host_a\npublic_key_sha256=FP",
    )
  })
})

describe("public key fingerprint", () => {
  test("is base64url sha256 over the decoded x||y bytes", async () => {
    const { privateKeyJwk } = await createHostKeyPair()
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from(privateKeyJwk.x!, "base64url"), Buffer.from(privateKeyJwk.y!, "base64url")]))
      .digest("base64url")

    expect(await publicKeyFingerprint({ kty: "EC", crv: "P-256", x: privateKeyJwk.x, y: privateKeyJwk.y })).toBe(
      expected,
    )
  })

  test("ignores JWK serialization differences", async () => {
    // The control plane compares keys by this value, never by JSON text —
    // field order and optional members must not produce a second identity.
    const { privateKeyJwk, publicKey } = await createHostKeyPair()
    const reordered = JSON.stringify({ y: privateKeyJwk.y, x: privateKeyJwk.x, crv: "P-256", kty: "EC", ext: true })

    expect(await publicKeyFingerprint(reordered)).toBe(await publicKeyFingerprint(publicKey))
    expect(await publicKeyFingerprint((await hostKeyPairFromJwk(privateKeyJwk)).publicKey)).toBe(
      await publicKeyFingerprint(publicKey),
    )
  })

  test("refuses anything but a P-256 public JWK", async () => {
    await expect(publicKeyFingerprint({ kty: "RSA", n: "x", e: "AQAB" })).rejects.toThrow(/P-256/)
  })
})

test("a host id is minted per state file and never repeats", () => {
  const ids = new Set([newHostId(), newHostId()])
  for (const id of ids) expect(id).toMatch(/^host_[A-Za-z0-9_-]{43}$/)
  expect(ids.size).toBe(2)
})
