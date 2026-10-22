import { createHash, createPrivateKey, X509Certificate } from "node:crypto"
import { describe, expect, test } from "vitest"
import { createDirectTlsKey, directTlsIdentity } from "./direct-certificate"

describe("directTlsIdentity", () => {
  test("is a certificate node:crypto parses, signed by its own key, whose SPKI hash is the pin", async () => {
    const jwk = await createDirectTlsKey()
    const now = Date.UTC(2026, 9, 22, 12, 0, 0)
    const identity = await directTlsIdentity(jwk, now)
    const certificate = new X509Certificate(identity.certPem)

    expect(certificate.verify(certificate.publicKey)).toBe(true)
    expect(certificate.subject).toBe("CN=claxedo-direct")
    expect(certificate.issuer).toBe("CN=claxedo-direct")
    expect(certificate.publicKey.asymmetricKeyType).toBe("ec")
    expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1")
    expect(new Date(certificate.validFrom).getTime()).toBe(now - 60 * 60 * 1000)
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(now + 9 * 365 * 24 * 60 * 60 * 1000)
    const spki = certificate.publicKey.export({ type: "spki", format: "der" })
    expect(identity.spkiSha256).toBe(createHash("sha256").update(spki).digest("base64url"))
    expect(createPrivateKey(identity.keyPem).asymmetricKeyType).toBe("ec")
    expect(certificate.checkPrivateKey(createPrivateKey(identity.keyPem))).toBe(true)
  })

  test("keeps the pin across certificates minted from the same key, and changes it with the key", async () => {
    const jwk = await createDirectTlsKey()
    const [first, second, other] = await Promise.all([
      directTlsIdentity(jwk),
      directTlsIdentity(jwk),
      createDirectTlsKey().then((key) => directTlsIdentity(key)),
    ])

    expect(new X509Certificate(first.certPem).serialNumber).not.toBe(new X509Certificate(second.certPem).serialNumber)
    expect(second.spkiSha256).toBe(first.spkiSha256)
    expect(other.spkiSha256).not.toBe(first.spkiSha256)
  })
})
