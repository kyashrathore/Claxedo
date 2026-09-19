/**
 * Offline gate over the deployed-Cloudflare acceptance harness.
 *
 * ## This file talks to nothing
 *
 * Every assertion below is local: origin/run-id parsing, and the signed
 * payload literals verified against a key generated in-process. No fetch, no
 * deployment, no credentials. Passing it is NOT evidence that any deployed
 * system works — it is evidence that the harness would build the right bytes
 * if pointed at one. Do not cite a green run here as acceptance.
 *
 * Its value is the one failure it catches early and cheaply: a payload literal
 * drifting from the authority's verifier (`hostEnrollmentPayload` and the
 * machine-request payload, duplicated in the D1 and SQLite adapters and the
 * host-enrollment authority). That drift would otherwise surface as an opaque
 * `host_attestation_denied` from a live worker, at the slowest and most
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

import { createHash, createPublicKey, verify } from "node:crypto"
import { describe, expect, test } from "vitest"

import {
  acceptanceConfig,
  createMachineIdentity,
  enrollmentPayload,
  machineRequest,
  machineRequestPayload,
  MACHINE_REQUEST_HEADERS,
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

  test("carries the machine credential in headers alone, with the enrollment and host in the body", () => {
    const machine = createMachineIdentity()
    const built = machineRequest({
      machine,
      enrollmentId: "enr_acceptance",
      hostId: "host_acceptance",
      pathname: "/api/claxedo/host/enrollments/heartbeat",
      body: { generation: 3, acks: [] },
      ts: 1_700_000_000_000,
      nonce: "nonce_acceptance",
    })

    expect(JSON.parse(built.bodyText)).toEqual({
      enrollmentId: "enr_acceptance",
      hostId: "host_acceptance",
      generation: 3,
      acks: [],
    })
    // The whole header set, asserted as a whole: a cookie or an authorization
    // header added here would make the live journey pass on the owner's
    // credential instead of the machine's signature.
    expect(Object.keys(built.headers).sort()).toEqual(Object.values(MACHINE_REQUEST_HEADERS).sort())
    expect(
      verify(
        "sha256",
        Buffer.from(
          machineRequestPayload({
            method: "POST",
            pathname: "/api/claxedo/host/enrollments/heartbeat",
            bodySha256Hex: createHash("sha256").update(built.bodyText).digest("hex"),
            ts: 1_700_000_000_000,
            nonce: "nonce_acceptance",
            enrollmentId: "enr_acceptance",
          }),
        ),
        { key: createPublicKey({ key: JSON.parse(machine.publicKey), format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(built.headers[MACHINE_REQUEST_HEADERS.signature], "base64url"),
      ),
    ).toBe(true)
  })

  test("signs a machine request over the method, path, body hash, clock, nonce and enrollment", () => {
    // Field order IS the contract: the verifier rebuilds this literal from the
    // request that arrived, so a client that joined the same values in another
    // order would be refused with a signature error and nothing to read from
    // it.
    const machine = createMachineIdentity()
    const payload = machineRequestPayload({
      method: "post",
      pathname: "/api/claxedo/host/enrollments/heartbeat",
      bodySha256Hex: "abc123",
      ts: 1_700_000_000_000,
      nonce: "nonce_acceptance",
      enrollmentId: "enr_acceptance",
    })
    const publicKey = createPublicKey({ key: JSON.parse(machine.publicKey), format: "jwk" })

    expect(payload).toBe(
      [
        "claxedo.machine-request.v1",
        "POST",
        "/api/claxedo/host/enrollments/heartbeat",
        "abc123",
        "1700000000000",
        "nonce_acceptance",
        "enr_acceptance",
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
})
