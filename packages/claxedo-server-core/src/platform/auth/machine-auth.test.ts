import { beforeAll, describe, expect, test } from "vitest"
import { base64UrlEncode, sha256Hex } from "@claxedo/helpers/crypto"
import { MACHINE_NONCE_TTL_MS, MACHINE_REQUEST_HEADERS, MACHINE_REQUEST_SKEW_MS, machineRequestPayload } from "./host-connect-contract"
import type { MachineEnrollmentRow } from "./authority"
import { type MachineAuthDeps, type MachineRequest, verifyMachineRequest } from "./machine-auth"

const NOW = 1_726_000_000_000
const PATH = "/api/claxedo/host/enrollments/heartbeat"

type Signer = { publicKeyJson: string; sign: (payload: string) => Promise<string> }

async function signer(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return {
    publicKeyJson: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }),
    sign: async (payload) =>
      base64UrlEncode(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload)),
      ),
  }
}

let machine: Signer
let stranger: Signer

beforeAll(async () => {
  machine = await signer()
  stranger = await signer()
})

function row(overrides: Partial<MachineEnrollmentRow> = {}): MachineEnrollmentRow {
  return {
    enrollment_id: "enr_1",
    host_id: "host-a",
    owner_user_id: "user_1",
    owner_actor_id: "actor_1",
    public_key_json: machine.publicKeyJson,
    key_version: 1,
    serving_generation: 3,
    revoked_at: null,
    paused_at: null,
    scope: { revision: 2, allowed_roots: ["/srv"], visibility: "owner" },
    ownerEligible: true,
    ...overrides,
  }
}

function deps(options: { row?: MachineEnrollmentRow | undefined; now?: number } = {}) {
  const nonces = new Set<string>()
  const consumed: Array<{ enrollmentId: string; nonce: string; expiresAt: number }> = []
  const lookups: string[] = []
  const value: MachineAuthDeps = {
    lookupEnrollment: async (enrollmentId) => {
      lookups.push(enrollmentId)
      return "row" in options ? options.row : row()
    },
    consumeNonce: async (input) => {
      consumed.push(input)
      const key = `${input.enrollmentId}\n${input.nonce}`
      if (nonces.has(key)) return false
      nonces.add(key)
      return true
    },
    now: () => options.now ?? NOW,
  }
  return { deps: value, consumed, lookups }
}

async function signedRequest(input: {
  by?: Signer
  method?: string
  pathname?: string
  body?: string
  ts?: number
  nonce?: string
  enrollmentId?: string
  headerOverrides?: Record<string, string | null>
}): Promise<MachineRequest> {
  const by = input.by ?? machine
  const method = input.method ?? "POST"
  const pathname = input.pathname ?? PATH
  const body = input.body ?? JSON.stringify({ enrollmentId: "enr_1", hostId: "host-a", generation: 3, acks: [] })
  const ts = input.ts ?? NOW
  const nonce = input.nonce ?? "nonce-0123456789abcdef"
  const enrollmentId = input.enrollmentId ?? "enr_1"
  const signature = await by.sign(machineRequestPayload({
    method,
    pathname,
    bodySha256Hex: await sha256Hex(body),
    ts,
    nonce,
    enrollmentId,
  }))
  const headers = new Map<string, string>([
    [MACHINE_REQUEST_HEADERS.enrollmentId, enrollmentId],
    [MACHINE_REQUEST_HEADERS.ts, String(ts)],
    [MACHINE_REQUEST_HEADERS.nonce, nonce],
    [MACHINE_REQUEST_HEADERS.signature, signature],
  ])
  for (const [name, value] of Object.entries(input.headerOverrides ?? {})) {
    if (value === null) headers.delete(name)
    else headers.set(name, value)
  }
  return { method, pathname, headers: { get: (name) => headers.get(name) ?? null }, bodyText: body }
}

describe("verifyMachineRequest", () => {
  test("accepts a fresh request and returns the principal read from the row", async () => {
    const d = deps()
    const result = await verifyMachineRequest(await signedRequest({}), d.deps)
    expect(result).toEqual({
      ok: true,
      machine: {
        enrollmentId: "enr_1",
        hostId: "host-a",
        ownerUserId: "user_1",
        ownerActorId: "actor_1",
        scope: { revision: 2, allowed_roots: ["/srv"], visibility: "owner" },
        keyVersion: 1,
        generation: 3,
      },
    })
    expect(d.lookups).toEqual(["enr_1"])
    expect(d.consumed).toEqual([{ enrollmentId: "enr_1", nonce: "nonce-0123456789abcdef", expiresAt: NOW + MACHINE_NONCE_TTL_MS }])
  })

  test("accepts an empty body and a lowercase method", async () => {
    const result = await verifyMachineRequest(await signedRequest({ body: "", method: "post" }), deps().deps)
    expect(result.ok).toBe(true)
  })

  test("refuses the identical request a second time", async () => {
    const d = deps()
    const request = await signedRequest({})
    expect((await verifyMachineRequest(request, d.deps)).ok).toBe(true)
    expect(await verifyMachineRequest(request, d.deps)).toEqual({ ok: false, status: 401, code: "machine_nonce_replayed" })
    expect(d.consumed).toHaveLength(2)
  })

  test("the same nonce under another enrollment is a different nonce", async () => {
    const d = deps()
    expect((await verifyMachineRequest(await signedRequest({}), d.deps)).ok).toBe(true)
    const other = row({ enrollment_id: "enr_2" })
    const d2 = { ...d.deps, lookupEnrollment: async () => other }
    const request = await signedRequest({ enrollmentId: "enr_2", body: JSON.stringify({ enrollmentId: "enr_2" }) })
    expect((await verifyMachineRequest(request, d2)).ok).toBe(true)
  })

  describe("header shape → 400 before any lookup", () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ["missing enrollment id", { [MACHINE_REQUEST_HEADERS.enrollmentId]: null }],
      ["blank enrollment id", { [MACHINE_REQUEST_HEADERS.enrollmentId]: "  " }],
      ["missing ts", { [MACHINE_REQUEST_HEADERS.ts]: null }],
      ["non-integer ts", { [MACHINE_REQUEST_HEADERS.ts]: "1726000000000.5" }],
      ["negative ts", { [MACHINE_REQUEST_HEADERS.ts]: "-1" }],
      ["iso ts", { [MACHINE_REQUEST_HEADERS.ts]: "2026-09-14T00:00:00Z" }],
      ["missing nonce", { [MACHINE_REQUEST_HEADERS.nonce]: null }],
      ["short nonce", { [MACHINE_REQUEST_HEADERS.nonce]: "abcdefghijklmno" }],
      ["long nonce", { [MACHINE_REQUEST_HEADERS.nonce]: "a".repeat(65) }],
      ["padded nonce", { [MACHINE_REQUEST_HEADERS.nonce]: "abcdefghijklmnopqrstuv==" }],
      ["missing signature", { [MACHINE_REQUEST_HEADERS.signature]: null }],
      ["signature not base64url", { [MACHINE_REQUEST_HEADERS.signature]: "abc+def/ghi=" }],
      ["signature of the wrong length", { [MACHINE_REQUEST_HEADERS.signature]: base64UrlEncode(new Uint8Array(63)) }],
      ["der-looking signature", { [MACHINE_REQUEST_HEADERS.signature]: base64UrlEncode(new Uint8Array(70)) }],
    ]
    for (const [name, overrides] of cases) {
      test(name, async () => {
        const d = deps()
        expect(await verifyMachineRequest(await signedRequest({ headerOverrides: overrides }), d.deps)).toEqual({
          ok: false,
          status: 400,
          code: "machine_headers_invalid",
        })
        expect(d.lookups).toEqual([])
        expect(d.consumed).toEqual([])
      })
    }
  })

  describe("timestamp skew", () => {
    test("exactly 60 s early and late are accepted", async () => {
      expect((await verifyMachineRequest(await signedRequest({ ts: NOW - MACHINE_REQUEST_SKEW_MS }), deps().deps)).ok).toBe(true)
      expect((await verifyMachineRequest(await signedRequest({ ts: NOW + MACHINE_REQUEST_SKEW_MS }), deps().deps)).ok).toBe(true)
    })

    test("one millisecond beyond 60 s either way is refused before lookup", async () => {
      for (const ts of [NOW - MACHINE_REQUEST_SKEW_MS - 1, NOW + MACHINE_REQUEST_SKEW_MS + 1]) {
        const d = deps()
        expect(await verifyMachineRequest(await signedRequest({ ts }), d.deps)).toEqual({
          ok: false,
          status: 401,
          code: "machine_timestamp_skew",
        })
        expect(d.lookups).toEqual([])
      }
    })

    test("the nonce expiry is anchored on the request ts, not on server time", async () => {
      const d = deps()
      await verifyMachineRequest(await signedRequest({ ts: NOW - 30_000 }), d.deps)
      expect(d.consumed[0]?.expiresAt).toBe(NOW - 30_000 + MACHINE_NONCE_TTL_MS)
    })
  })

  test("unknown enrollment → 401 without consuming the nonce", async () => {
    const d = deps({ row: undefined })
    expect(await verifyMachineRequest(await signedRequest({}), d.deps)).toEqual({
      ok: false,
      status: 401,
      code: "machine_enrollment_unknown",
    })
    expect(d.consumed).toEqual([])
  })

  describe("eligibility → 403, checked before the signature", () => {
    const cases: Array<[string, Partial<MachineEnrollmentRow>, string]> = [
      ["revoked", { revoked_at: NOW - 1 }, "enrollment_revoked"],
      ["paused", { paused_at: NOW - 1 }, "enrollment_paused"],
      ["suspended owner", { ownerEligible: false }, "enrollment_owner_ineligible"],
      ["unparseable stored key", { public_key_json: "{" }, "enrollment_key_invalid"],
      ["private key stored", { public_key_json: JSON.stringify({ kty: "EC", crv: "P-256", x: "a", y: "b", d: "c" }) }, "enrollment_key_invalid"],
      ["wrong curve", { public_key_json: JSON.stringify({ kty: "EC", crv: "P-384", x: "a", y: "b" }) }, "enrollment_key_invalid"],
    ]
    for (const [name, overrides, code] of cases) {
      test(name, async () => {
        const d = deps({ row: row(overrides) })
        // Signed by a stranger: the refusal must come from eligibility, not the signature.
        expect(await verifyMachineRequest(await signedRequest({ by: stranger }), d.deps)).toEqual({ ok: false, status: 403, code })
        expect(d.consumed).toEqual([])
      })
    }

    test("revoked wins over paused", async () => {
      const d = deps({ row: row({ revoked_at: NOW - 1, paused_at: NOW - 1 }) })
      expect((await verifyMachineRequest(await signedRequest({}), d.deps))).toMatchObject({ code: "enrollment_revoked" })
    })
  })

  describe("key version", () => {
    test("a body that declares the key version it signed with must match the row", async () => {
      const d = deps({ row: row({ key_version: 2 }) })
      const body = JSON.stringify({ enrollmentId: "enr_1", hostId: "host-a", keyVersion: 1 })
      expect(await verifyMachineRequest(await signedRequest({ body }), d.deps)).toEqual({
        ok: false,
        status: 403,
        code: "enrollment_key_version_mismatch",
      })
      expect(d.consumed).toEqual([])
    })

    test("a matching declared key version is accepted and reported", async () => {
      const d = deps({ row: row({ key_version: 2 }) })
      const body = JSON.stringify({ enrollmentId: "enr_1", hostId: "host-a", keyVersion: 2 })
      const result = await verifyMachineRequest(await signedRequest({ body }), d.deps)
      expect(result).toMatchObject({ ok: true, machine: { keyVersion: 2 } })
    })

    test("a signature from the key the row no longer holds is refused", async () => {
      const d = deps({ row: row({ key_version: 2, public_key_json: stranger.publicKeyJson }) })
      expect(await verifyMachineRequest(await signedRequest({ by: machine }), d.deps)).toEqual({
        ok: false,
        status: 401,
        code: "machine_signature_invalid",
      })
      expect(d.consumed).toEqual([])
    })
  })

  describe("signature", () => {
    test("another key → 401 without consuming the nonce", async () => {
      const d = deps()
      expect(await verifyMachineRequest(await signedRequest({ by: stranger }), d.deps)).toEqual({
        ok: false,
        status: 401,
        code: "machine_signature_invalid",
      })
      expect(d.consumed).toEqual([])
    })

    test("body tampering after signing", async () => {
      const request = await signedRequest({})
      const tampered = { ...request, bodyText: JSON.stringify({ enrollmentId: "enr_1", hostId: "host-a", generation: 99, acks: [] }) }
      expect(await verifyMachineRequest(tampered, deps().deps)).toMatchObject({ ok: false, status: 401, code: "machine_signature_invalid" })
    })

    test("a whitespace-only change to the body is a different body", async () => {
      const request = await signedRequest({ body: '{"a":1}' })
      expect(await verifyMachineRequest({ ...request, bodyText: '{"a": 1}' }, deps().deps)).toMatchObject({ code: "machine_signature_invalid" })
    })

    test("the signature binds method and pathname", async () => {
      const request = await signedRequest({})
      expect(await verifyMachineRequest({ ...request, method: "PUT" }, deps().deps)).toMatchObject({ code: "machine_signature_invalid" })
      expect(await verifyMachineRequest({ ...request, pathname: "/api/claxedo/host/enrollments/acquire" }, deps().deps))
        .toMatchObject({ code: "machine_signature_invalid" })
    })

    test("the signature binds ts and nonce headers", async () => {
      const request = await signedRequest({})
      const retimed = await signedRequest({ headerOverrides: { [MACHINE_REQUEST_HEADERS.ts]: String(NOW + 1) } })
      expect(await verifyMachineRequest(retimed, deps().deps)).toMatchObject({ code: "machine_signature_invalid" })
      const renonced = { ...request, headers: { get: (name: string) => name === MACHINE_REQUEST_HEADERS.nonce ? "other-nonce-0123456789" : request.headers.get(name) } }
      expect(await verifyMachineRequest(renonced, deps().deps)).toMatchObject({ code: "machine_signature_invalid" })
    })

    test("a valid signature presented under another enrollment's headers", async () => {
      const request = await signedRequest({})
      const other = { ...request, headers: { get: (name: string) => name === MACHINE_REQUEST_HEADERS.enrollmentId ? "enr_2" : request.headers.get(name) } }
      const d = deps({ row: row({ enrollment_id: "enr_2" }) })
      expect(await verifyMachineRequest(other, d.deps)).toMatchObject({ ok: false, status: 401, code: "machine_signature_invalid" })
    })
  })

  describe("body identity", () => {
    test("body enrollmentId must equal the header, refused before lookup", async () => {
      const d = deps()
      const body = JSON.stringify({ enrollmentId: "enr_2", hostId: "host-a" })
      expect(await verifyMachineRequest(await signedRequest({ body }), d.deps)).toEqual({
        ok: false,
        status: 401,
        code: "machine_signature_invalid",
      })
      expect(d.lookups).toEqual([])
    })

    test("body hostId must equal the row's", async () => {
      const body = JSON.stringify({ enrollmentId: "enr_1", hostId: "host-b" })
      expect(await verifyMachineRequest(await signedRequest({ body }), deps().deps)).toEqual({
        ok: false,
        status: 401,
        code: "machine_signature_invalid",
      })
    })

    test("a body without identity fields relies on the signature alone", async () => {
      expect((await verifyMachineRequest(await signedRequest({ body: "{}" }), deps().deps)).ok).toBe(true)
    })

    test("non-JSON, array and wrongly typed identity bodies → 400", async () => {
      for (const body of ["not json", "[1]", "null", JSON.stringify({ enrollmentId: 5 }), JSON.stringify({ hostId: {} }), JSON.stringify({ keyVersion: "1" })]) {
        expect(await verifyMachineRequest(await signedRequest({ body }), deps().deps)).toEqual({
          ok: false,
          status: 400,
          code: "machine_body_invalid",
        })
      }
    })
  })
})
