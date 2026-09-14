import { describe, expect, test } from "vitest"

import { HostConnectDecisionError, redeemInvitation } from "./bootstrap"
import { createFakeControlPlane, memoryHostStateFs } from "./fake-control-plane.test-support"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "./host-identity"
import { createHostStateStore, newHostState, parseHostState } from "./host-state"
import { HostedRequestTimeoutError, type FetchLike } from "./machine-transport"

/**
 * The bootstrap's writes, in order, against the strict fake. The recovery
 * tests are the ones that matter: a redeem the control plane committed but
 * whose answer never arrived must be recoverable by redeeming again with the
 * same key — and only the same key.
 */

const STATE_FILE = "/home/u/.claxedo/connect/state.json"
const TOKEN_FILE = "/etc/claxedo/invite.txt"

async function freshHost(cp = createFakeControlPlane(), input: { hostId?: string; cliRoots?: string[] } = {}) {
  const created = await createHostKeyPair()
  const keys = await hostKeyPairFromJwk(created.privateKeyJwk)
  const memory = memoryHostStateFs()
  const store = createHostStateStore({ file: STATE_FILE, fs: memory.fs, random: () => "t" })
  const state = newHostState({
    hostId: input.hostId ?? newHostId(),
    privateKeyJwk: created.privateKeyJwk,
    controlPlaneUrl: cp.url,
    cliRoots: input.cliRoots ?? [],
    storageRoot: "/var/lib/claxedo",
    now: () => 1_000,
  })
  const invitation = await cp.createInvitation({ scope: { revision: 1, allowed_roots: ["/srv"], visibility: "owner" } })
  memory.files.set(TOKEN_FILE, { text: invitation.token + "\n", mode: 0o600 })
  const redeem = (overrides: Partial<Parameters<typeof redeemInvitation>[0]> = {}) =>
    redeemInvitation({ tokenFile: TOKEN_FILE, store, state, keys, fetch: cp.fetch, displayName: "build box", ...overrides })
  const stored = () => {
    const text = memory.files.get(STATE_FILE)?.text
    return text === undefined ? undefined : parseHostState(text)
  }
  return { cp, keys, created, memory, store, state, invitation, redeem, stored }
}

describe("a fresh redeem", () => {
  test("persists the key and the pending marker before the request, then the enrollment, then removes the token", async () => {
    const h = await freshHost()
    let atRequest: ReturnType<typeof h.stored>
    const fetchSpy: FetchLike = async (input, init) => {
      atRequest = h.stored()
      return h.cp.fetch(input, init)
    }

    const outcome = await h.redeem({ fetch: fetchSpy })

    expect(atRequest, "the key was on disk before the control plane heard from us").toMatchObject({
      host_id: h.state.host_id,
      private_key_jwk: h.state.private_key_jwk,
      control_plane_url: h.cp.url,
      bootstrap: { invitation_id: h.invitation.invitationId, token_file: TOKEN_FILE },
    })
    expect(atRequest?.enrollment).toBeUndefined()

    expect(outcome.resumed).toBe(false)
    expect(outcome.state).toMatchObject({
      enrollment: {
        enrollment_id: expect.stringMatching(/^enr_/),
        owner_display: "Alice",
        org_id: "org_1",
        enrolled_via: "invitation",
        key_version: 1,
      },
      relay: { url: `${h.cp.url}/relay`, jwksUrl: `${h.cp.url}/relay/jwks` },
      authority: { sessionAuthorityUrl: `${h.cp.url}/api/runtime-authority` },
      scope: { revision: 1, allowed_roots: ["/srv"], visibility: "owner" },
    })
    expect(outcome.state.bootstrap).toBeUndefined()
    expect(h.stored()).toEqual(outcome.state)
    expect(h.memory.files.has(TOKEN_FILE), "the single-use token does not outlive its redeem").toBe(false)

    const writes = h.memory.calls.filter((call) => call.startsWith("rename") || call.startsWith("unlink"))
    expect(writes).toEqual([
      `rename ${STATE_FILE}.t.tmp -> ${STATE_FILE}`,
      `rename ${STATE_FILE}.t.tmp -> ${STATE_FILE}`,
      `unlink ${TOKEN_FILE}`,
      `rename ${STATE_FILE}.t.tmp -> ${STATE_FILE}`,
    ])
    expect(h.cp.log[0]?.body).toMatchObject({
      invitationId: h.invitation.invitationId,
      secret: h.invitation.secret,
      hostId: h.state.host_id,
      displayName: "build box",
    })
    expect(JSON.parse(h.cp.log[0]?.body.publicKey as string)).not.toHaveProperty("d")
  })
})

describe("recovery", () => {
  test("a redeem whose response was lost is resumed on the next boot with the same key, and enrolls once", async () => {
    const h = await freshHost()
    h.cp.faults.dropRedeemResponse = true

    const lost = await h.redeem().catch((e: unknown) => e)

    expect(lost).toBeInstanceOf(TypeError)
    expect(lost).not.toBeInstanceOf(HostConnectDecisionError)
    expect(h.cp.enrollments.size, "the control plane committed").toBe(1)
    const pending = h.stored()
    expect(pending?.bootstrap).toEqual({ invitation_id: h.invitation.invitationId, token_file: TOKEN_FILE })
    expect(pending?.enrollment).toBeUndefined()
    expect(h.memory.files.has(TOKEN_FILE)).toBe(true)

    // Next boot: same state file, same key, same token.
    const outcome = await h.redeem({ state: pending! })

    expect(outcome.resumed).toBe(true)
    expect(outcome.state.enrollment?.enrollment_id).toBe([...h.cp.enrollments.keys()][0])
    expect(h.cp.enrollments.size, "no second enrollment").toBe(1)
    expect(outcome.state.bootstrap).toBeUndefined()
    expect(h.memory.files.has(TOKEN_FILE)).toBe(false)
  })

  test("the same token with a different key is invitation_redeemed, exit 78", async () => {
    const h = await freshHost()
    await h.redeem()
    const intruder = await freshHost(h.cp, { hostId: h.state.host_id })
    intruder.memory.files.set(TOKEN_FILE, { text: h.invitation.token, mode: 0o600 })

    const error = await intruder.redeem().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostConnectDecisionError)
    expect(error).toMatchObject({ exitCode: 78, code: "invitation_redeemed", status: 409 })
    expect(h.cp.enrollments.size).toBe(1)
  })

  test("the right key with a different host id is not a resume either", async () => {
    const h = await freshHost()
    await h.redeem()
    const other = await freshHost(h.cp)
    other.memory.files.set(TOKEN_FILE, { text: h.invitation.token, mode: 0o600 })

    const error = await other.redeem({ keys: h.keys }).catch((e: unknown) => e)

    expect(error).toMatchObject({ exitCode: 78, code: "invitation_redeemed" })
  })
})

describe("decisions", () => {
  test("a wrong secret is invitation_invalid and says nothing else", async () => {
    const h = await freshHost()
    h.memory.files.set(TOKEN_FILE, { text: `chx_inv_1.${h.invitation.invitationId}.wrongsecret`, mode: 0o600 })

    const error = await h.redeem().catch((e: unknown) => e)

    expect(error).toMatchObject({ exitCode: 78, code: "invitation_invalid", status: 400 })
    expect(String((error as Error).cause)).not.toContain("redeemed")
  })

  test("an expired invitation", async () => {
    const h = await freshHost()
    h.invitation.invitation.expires_at = 0

    expect(await h.redeem().catch((e: unknown) => e)).toMatchObject({ exitCode: 78, code: "invitation_expired" })
  })

  test("a revoked invitation", async () => {
    const h = await freshHost()
    h.invitation.invitation.revoked_at = 1

    expect(await h.redeem().catch((e: unknown) => e)).toMatchObject({ exitCode: 78, code: "invitation_revoked" })
  })

  test("an occupied host id — live or revoked — is invitation_host_conflict", async () => {
    const h = await freshHost()
    const first = await h.redeem()
    h.cp.revoke(first.state.enrollment!.enrollment_id)
    const replacement = await freshHost(h.cp, { hostId: h.state.host_id })

    const error = await replacement.redeem().catch((e: unknown) => e)

    expect(error).toMatchObject({ exitCode: 78, code: "invitation_host_conflict", status: 409 })
    expect(h.cp.enrollments.size).toBe(1)
  })

  test("a malformed token never reaches the control plane", async () => {
    const h = await freshHost()
    h.memory.files.set(TOKEN_FILE, { text: "chx_inv_0.a.b", mode: 0o600 })

    await expect(h.redeem()).rejects.toThrow(/chx_inv_1/)
    expect(h.cp.log).toEqual([])
  })

  test("a missing token file is a decision", async () => {
    const h = await freshHost()

    const error = await h.redeem({ tokenFile: "/nope" }).catch((e: unknown) => e)

    expect(error).toMatchObject({ exitCode: 78 })
    expect(h.cp.log).toEqual([])
  })

  test("an already enrolled state refuses to redeem", async () => {
    const h = await freshHost()
    const { state } = await h.redeem()
    const requests = h.cp.log.length

    const error = await h.redeem({ state }).catch((e: unknown) => e)

    expect(error).toMatchObject({ exitCode: 78 })
    expect(String(error)).toContain("already enrolled")
    expect(h.cp.log).toHaveLength(requests)
  })

  test("a different invitation while one is pending is refused before any request", async () => {
    const h = await freshHost()
    h.cp.faults.dropRedeemResponse = true
    await h.redeem().catch(() => undefined)
    const pending = h.stored()!
    const another = await h.cp.createInvitation({ scope: { revision: 1, allowed_roots: ["/srv"], visibility: "owner" } })
    h.memory.files.set(TOKEN_FILE, { text: another.token, mode: 0o600 })
    const requests = h.cp.log.length

    const error = await h.redeem({ state: pending }).catch((e: unknown) => e)

    expect(error).toMatchObject({ exitCode: 78 })
    expect(h.cp.log).toHaveLength(requests)
  })

  test("a control plane outage is not a decision", async () => {
    const h = await freshHost()
    const error = await h
      .redeem({
        fetch: async () => new Response(JSON.stringify({ error: { code: "deployment_candidate_unavailable" } }), { status: 503 }),
      })
      .catch((e: unknown) => e)

    expect(error).not.toBeInstanceOf(HostConnectDecisionError)
    expect(String(error)).toContain("HOSTED_HTTP 503")
    expect(h.stored()?.bootstrap, "the pending marker stays for the retry").toBeDefined()
  })

  test("a control plane that never answers is a timeout, not a decision, and leaves the marker for the retry", async () => {
    const h = await freshHost()
    const never: FetchLike = () => new Promise(() => undefined)

    const error = await h.redeem({ fetch: never, requestTimeoutMs: 20 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostedRequestTimeoutError)
    expect(String(error)).toContain("did not answer POST /api/claxedo/host/enrollments/redeem within 0.02s")
    expect(h.stored()?.bootstrap).toBeDefined()
  })
})
