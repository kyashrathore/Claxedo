/**
 * Offline gate over the deployed-Cloudflare acceptance harness.
 *
 * ## This file talks to nothing
 *
 * Every assertion below is local: origin/run-id parsing, and the two signed
 * payload literals verified against a key generated in-process. No fetch, no
 * deployment, no credentials. Passing it is NOT evidence that any deployed
 * system works — it is evidence that the harness would build the right bytes
 * if pointed at one. Do not cite a green run here as acceptance.
 *
 * Its value is the one failure it catches early and cheaply: a payload literal
 * drifting from the authority's verifier (`hostEnrollmentPayload` /
 * `hostEnrollmentHeartbeatPayloadV2`, duplicated in the D1 and SQLite adapters
 * and `convex/hostEnrollments.ts`). That drift would otherwise surface as an
 * opaque `host_attestation_denied` from a live worker, at the slowest and most
 * expensive point in the loop.
 *
 * Run: `bun run test:deployed-acceptance` (also chained into `bun run test`).
 *
 * ## The live run is a different command
 *
 * `bun run test:e2e:deployed-cloudflare -- --<stage>` drives a REAL deployment
 * through Playwright and is never part of CI. Its stages and required
 * environment are documented at the top of `../deployed-cloudflare-acceptance.ts`.
 */

import { createPublicKey, verify } from "node:crypto"
import { describe, expect, test } from "vitest"

import {
  acceptanceConfig,
  createMachineIdentity,
  enrollmentPayload,
  heartbeatPayloadV2,
} from "../deployed-cloudflare-acceptance"

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

  test("signs the exact enrollment payload the authority verifies", () => {
    const input = { hostId: "host_acceptance", requestId: "request_acceptance", nonce: "nonce_acceptance" }
    const machine = createMachineIdentity()
    const payload = enrollmentPayload(input)
    const publicKey = createPublicKey({ key: JSON.parse(machine.publicKey), format: "jwk" })

    expect(payload).toBe(
      [
        "claxedo.host-enrollment.enroll.v1",
        "host_id=host_acceptance",
        "request_id=request_acceptance",
        "nonce=nonce_acceptance",
      ].join("\n"),
    )
    expect(
      verify(
        "sha256",
        Buffer.from(payload),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(machine.sign(payload), "base64url"),
      ),
    ).toBe(true)
  })

  test("covers the served set in one heartbeat v2 signature, sorted", () => {
    // Sorted and comma-joined is the contract, not a formatting choice: the
    // authority rebuilds this literal from ITS view of the set, so a client
    // that signed the caller's order would be rejected whenever the two
    // disagreed.
    const machine = createMachineIdentity()
    const payload = heartbeatPayloadV2({ hostId: "host_acceptance", workspaceIds: ["ws_b", "ws_a"] })
    const publicKey = createPublicKey({ key: JSON.parse(machine.publicKey), format: "jwk" })

    expect(payload).toBe(
      [
        "claxedo.host-enrollment.heartbeat.v2",
        "host_id=host_acceptance",
        "ttl_ms=",
        "workspaces=ws_a,ws_b",
      ].join("\n"),
    )
    expect(heartbeatPayloadV2({ hostId: "host_acceptance", workspaceIds: ["ws_a", "ws_b"] })).toBe(payload)
    expect(
      verify(
        "sha256",
        Buffer.from(payload),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(machine.sign(payload), "base64url"),
      ),
    ).toBe(true)
  })
})
