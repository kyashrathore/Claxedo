import { createPublicKey, verify } from "node:crypto"
import { describe, expect, test } from "vitest"

import { acceptanceConfig, createColdWorkspaceProof, registrationPayload } from "../deployed-cloudflare-acceptance"

describe("deployed Cloudflare acceptance runner", () => {
  test("accepts only exact HTTPS deployment origins and a filesystem-safe run id", () => {
    const config = acceptanceConfig(
      {
        CLAXEDO_DEPLOYED_API_URL: "https://api.example.test/",
        CLAXEDO_DEPLOYED_APP_URL: "https://app.example.test",
        CLAXEDO_DEPLOYED_ACCEPTANCE_ID: "release-2026.08.31",
      },
      "/tmp/claxedo-app",
    )

    expect(config).toMatchObject({
      apiOrigin: "https://api.example.test",
      appOrigin: "https://app.example.test",
      acceptanceId: "release-2026.08.31",
      stateRoot: "/tmp/claxedo-app/.artifacts/deployed-cloudflare-acceptance/release-2026.08.31",
    })

    expect(() =>
      acceptanceConfig(
        {
          CLAXEDO_DEPLOYED_API_URL: "http://api.example.test",
          CLAXEDO_DEPLOYED_APP_URL: "https://app.example.test",
          CLAXEDO_DEPLOYED_ACCEPTANCE_ID: "release",
        },
        "/tmp/claxedo-app",
      ),
    ).toThrow("HTTPS origin")
    expect(() =>
      acceptanceConfig(
        {
          CLAXEDO_DEPLOYED_API_URL: "https://api.example.test/path",
          CLAXEDO_DEPLOYED_APP_URL: "https://app.example.test",
          CLAXEDO_DEPLOYED_ACCEPTANCE_ID: "../escape",
        },
        "/tmp/claxedo-app",
      ),
    ).toThrow()
  })

  test("creates the exact P-256 ieee-p1363 cold-registration proof", () => {
    const input = {
      workspaceId: "ws_acceptance",
      hostId: "host_acceptance",
      challengeId: "challenge_acceptance",
      nonce: "nonce_acceptance",
    }
    const proof = createColdWorkspaceProof(input)
    const payload = registrationPayload(input)
    const publicKey = createPublicKey({ key: JSON.parse(proof.publicKey), format: "jwk" })

    expect(payload).toBe(
      [
        "claxedo.local-host-link.register.v1",
        "workspace_id=ws_acceptance",
        "host_id=host_acceptance",
        "challenge_id=challenge_acceptance",
        "nonce=nonce_acceptance",
      ].join("\n"),
    )
    expect(
      verify(
        "sha256",
        Buffer.from(payload),
        {
          key: publicKey,
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(proof.signature, "base64url"),
      ),
    ).toBe(true)
  })
})
