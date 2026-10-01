import { expect, test } from "bun:test"
import { base64UrlDecode, base64UrlEncode } from "@claxedo/helpers/crypto"
import {
  MACHINE_REQUEST_HEADERS,
  decodeInvitationToken,
  decodeMachineSeal,
  encodeMachineSeal,
  enrollmentPayload,
  invitationRedeemPayload,
  invitationToken,
  machineRequestPayload,
  machineSealAad,
  publicKeyFingerprint,
} from "./machine"

test("machine signing strings preserve their domains and field order", () => {
  expect(
    machineRequestPayload({
      method: "post",
      pathname: "/api/claxedo/host/enrollments/heartbeat",
      bodySha256Hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ts: 1726000000000,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      enrollmentId: "enr_abc",
    }),
  ).toBe(
    "claxedo.machine-request.v1\nPOST\n/api/claxedo/host/enrollments/heartbeat\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1726000000000\nAAAAAAAAAAAAAAAAAAAAAA\nenr_abc",
  )
  expect(enrollmentPayload({ hostId: "h", requestId: "r", nonce: "n" })).toBe(
    "claxedo.host-enrollment.enroll.v1\nhost_id=h\nrequest_id=r\nnonce=n",
  )
  expect(invitationRedeemPayload({ invitationId: "inv_1", hostId: "host-a", publicKeySha256: "fp_x" })).toBe(
    "claxedo.host-enrollment.redeem.v1\ninvitation_id=inv_1\nhost_id=host-a\npublic_key_sha256=fp_x",
  )
})

test("invitation encoding is exact and decoding refuses malformed parts", () => {
  expect(invitationToken({ invitationId: "inv_AbC-_1", secret: "s3cr3t-_x" })).toBe("chx_inv_1.inv_AbC-_1.s3cr3t-_x")
  expect(decodeInvitationToken("chx_inv_1.inv_AbC-_1.s3cr3t-_x")).toEqual({
    invitationId: "inv_AbC-_1",
    secret: "s3cr3t-_x",
  })
  for (const raw of [
    "chx_inv_2.a.b",
    "chx_inv_1.a",
    "chx_inv_1.a.b.c",
    "chx_inv_1..b",
    "chx_inv_1.a.b=",
    " chx_inv_1.a.b",
    "chx_inv_1.a.",
    "chx_inv_1.a b.c",
    "",
  ])
    expect(decodeInvitationToken(raw)).toBeUndefined()
})

test("machine request header names", () => {
  expect(MACHINE_REQUEST_HEADERS).toEqual({
    enrollmentId: "x-claxedo-enrollment-id",
    ts: "x-claxedo-host-ts",
    nonce: "x-claxedo-host-nonce",
    signature: "x-claxedo-host-signature",
  })
})

test("seal AAD pins enrollment and revision", () => {
  expect(machineSealAad({ enrollmentId: "enr_vector", revision: 7 })).toBe("claxedo.machine-seal.v1\nenr_vector\n7")
})

test("sealed envelopes pin their version and base64url separators", () => {
  expect(
    encodeMachineSeal({
      ephemeral: new Uint8Array([4, 42]),
      iv: new Uint8Array([1, 2, 3]),
      ciphertext: new Uint8Array([255, 254]),
    }),
  ).toBe("mseal1.BCo.AQID.__4")
  expect(decodeMachineSeal("mseal1.BCo.AQID.__4")).toEqual({ ephemeral: "BCo", iv: "AQID", ciphertext: "__4" })
  for (const raw of ["mseal2.BCo.AQID.__4", "mseal1.BCo.AQID", "mseal1.BCo.AQID.__4.extra"])
    expect(() => decodeMachineSeal(raw)).toThrow("is not mseal1")
})

test("fingerprint hashes decoded coordinates regardless of JWK serialization", async () => {
  const key = {
    kty: "EC",
    crv: "P-256",
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    y: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  }
  expect(await publicKeyFingerprint(key)).toBe("9aX9QtFqIDAnmO9u0wmXm0MAPSMg2fDo6pgxqSdZ-0s")
  expect(
    await publicKeyFingerprint(JSON.stringify({ y: key.y, x: key.x, crv: key.crv, kty: key.kty, ext: true })),
  ).toBe("9aX9QtFqIDAnmO9u0wmXm0MAPSMg2fDo6pgxqSdZ-0s")
  await expect(publicKeyFingerprint({ ...key, x: "a+b" })).rejects.toThrow(TypeError)
})

test("fingerprint is sha256 over the decoded x||y bytes of a generated key", async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const x = base64UrlDecode(jwk.x!)
  const y = base64UrlDecode(jwk.y!)
  const material = new Uint8Array(x.length + y.length)
  material.set(x, 0)
  material.set(y, x.length)
  expect(await publicKeyFingerprint(jwk)).toBe(base64UrlEncode(await crypto.subtle.digest("SHA-256", material)))
  await expect(publicKeyFingerprint({ kty: "RSA", n: "x", e: "AQAB" })).rejects.toThrow(TypeError)
})
