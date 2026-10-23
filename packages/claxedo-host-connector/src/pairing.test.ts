import { describe, expect, test, vi } from "vitest"

import { HostConnectDecisionError, redeemPairing, type PairingMachine } from "./bootstrap"
import { createHostConnector, type OwnerHold } from "./connector"
import { createFakeControlPlane, enrollFakeHost, memoryHostStateFs, type FakeControlPlane } from "./fake-control-plane.test-support"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "./host-identity"
import { createHostStateStore, effectiveRoots, newHostState, parseHostState, type HostState } from "./host-state"
import { createMachinePairingClient, createMachineSignedTransport, type FetchLike } from "./machine-transport"

const STATE_FILE = "/home/u/.claxedo/connect/state.json"
const MACHINE: PairingMachine = { hostname: "build-box", os: "Ubuntu 24.04", arch: "x64", cli_version: "0.2.2", folder: "/srv/api", home: "/home/u" }

async function pairingHost(cp: FakeControlPlane, now?: () => number) {
  const created = await createHostKeyPair()
  const keys = await hostKeyPairFromJwk(created.privateKeyJwk)
  const memory = memoryHostStateFs()
  const store = createHostStateStore({ file: STATE_FILE, fs: memory.fs, random: () => "t" })
  const state = newHostState({ hostId: newHostId(), privateKeyJwk: created.privateKeyJwk, controlPlaneUrl: cp.url, cliRoots: [], storageRoot: "/var/lib/claxedo" })
  const redeem = (code: string, overrides: Partial<Parameters<typeof redeemPairing>[0]> = {}) =>
    redeemPairing({ code, store, state, keys, machine: MACHINE, fetch: cp.fetch, ...overrides })
  const stored = () => {
    const text = memory.files.get(STATE_FILE)?.text
    return text === undefined ? undefined : parseHostState(text)
  }
  const signed = (enrolled: HostState) => {
    const options = {
      controlPlaneUrl: cp.url,
      keys,
      enrollmentId: enrolled.enrollment?.enrollment_id ?? "",
      hostId: enrolled.host_id,
      keyVersion: enrolled.enrollment?.key_version ?? 1,
      fetch: cp.fetch,
      ...(now ? { now } : {}),
    }
    return { transport: createMachineSignedTransport(options), client: createMachinePairingClient(options) }
  }
  return { keys, store, state, redeem, stored, signed }
}

function pairedConnector(enrolled: HostState, transport: ReturnType<typeof createMachineSignedTransport>) {
  const holds: Array<OwnerHold | undefined> = []
  const tunnels: Array<Record<string, unknown> | undefined> = []
  const errors: unknown[] = []
  let state = enrolled
  let tick: (() => void) | undefined
  const connector = createHostConnector({
    mode: "machine",
    hostId: enrolled.host_id,
    transport,
    enrollmentId: enrolled.enrollment?.enrollment_id ?? "",
    heartbeatIntervalMs: 25_000,
    sessionAuthority: "managed-private",
    roots: () => effectiveRoots(state, async (p) => p),
    resolvePath: async (p) => p,
    setInterval: (fn) => {
      tick = fn
      return { cancel: () => undefined }
    },
    onScope: (scope) => {
      state = { ...state, scope }
    },
    onAssignments: async (descriptions) => {
      for (const d of descriptions) await connector.ack({ workspaceId: d.workspaceId, revision: d.revision })
    },
    onServing: (tunnel) => tunnels.push(tunnel),
    onHeld: (hold) => holds.push(hold),
    onError: (_stage, error) => errors.push(error),
  })
  return { connector, holds, tunnels, errors, tick: () => tick?.(), scope: () => state.scope }
}

const refusalCode = (error: unknown) => (error instanceof HostConnectDecisionError ? error.code : undefined)

describe("redeeming a pairing code", () => {
  test("persists the key before the request, and enrolls a machine that waits for its owner with no roots", async () => {
    const cp = createFakeControlPlane()
    const h = await pairingHost(cp)
    const pairing = cp.pairings.create()
    let atRequest: HostState | undefined
    const spy: FetchLike = async (input, init) => {
      atRequest = h.stored()
      return cp.fetch(input, init)
    }

    const outcome = await h.redeem(pairing.code.toLowerCase().replace(/(.{5})/g, "$1-"), { fetch: spy })

    expect(atRequest?.private_key_jwk, "the key was on disk before the code left").toEqual(h.state.private_key_jwk)
    expect(outcome.resumed).toBe(false)
    expect(outcome.approvalUrl).toBe(`${cp.url}/settings/machines`)
    expect(h.stored()).toMatchObject({
      pairing: { pairing_id: pairing.pairing_id, approval_url: `${cp.url}/settings/machines` },
      enrollment: { enrollment_id: outcome.state.enrollment?.enrollment_id },
      scope: { allowed_roots: [] },
    })
    expect(cp.enrollments.get(outcome.state.enrollment?.enrollment_id ?? "")?.approval_requested_at).toBeTypeOf("number")
  })

  test("a redeem whose answer was lost is resumed with the same key, and a different key is refused as a used code", async () => {
    const cp = createFakeControlPlane()
    const h = await pairingHost(cp)
    const pairing = cp.pairings.create()
    const first = await h.redeem(pairing.code)
    const again = await h.redeem(pairing.code)
    expect(again.resumed).toBe(true)
    expect(again.state.enrollment?.enrollment_id).toBe(first.state.enrollment?.enrollment_id)
    expect(cp.enrollments.size).toBe(1)

    const other = await pairingHost(cp)
    const refused = await other.redeem(pairing.code).catch((error: unknown) => error)
    expect(refusalCode(refused)).toBe("pairing_used")
    expect((refused as Error).message).toBe("This code was already used; open Connect a machine… in Claxedo for a new one.")
  })

  test("a code that is malformed never reaches the control plane; an expired one and a signed-out owner's are told apart", async () => {
    let now = 1_000_000
    const cp = createFakeControlPlane({ now: () => now })
    const h = await pairingHost(cp)
    const requests = cp.log.length
    expect(refusalCode(await h.redeem("not-a-code").catch((error: unknown) => error))).toBe("pairing_invalid")
    expect(cp.log.length).toBe(requests)

    const expired = cp.pairings.create()
    now += 15 * 60_000 + 1
    expect(refusalCode(await h.redeem(expired.code).catch((error: unknown) => error))).toBe("pairing_expired")

    const signedOut = cp.pairings.create()
    cp.pairings.signOut()
    const refused = await h.redeem(signedOut.code).catch((error: unknown) => error)
    expect(refusalCode(refused)).toBe("pairing_owner_signed_out")
    expect((refused as Error).message).toBe("The person who made this code signed out; make a new one in Claxedo.")
  })
})

describe("a paired machine waiting for its owner", () => {
  test("holds its doorbell while it waits, and serves the approved folder the moment the approval rings", async () => {
    const cp = createFakeControlPlane()
    const h = await pairingHost(cp)
    const pairing = cp.pairings.create()
    const { state } = await h.redeem(pairing.code)
    const { transport, client } = h.signed(state)
    const m = pairedConnector(state, transport)
    const enrollmentId = state.enrollment?.enrollment_id ?? ""

    const starting = m.connector.start()
    await vi.waitFor(() => expect(m.holds).toEqual(["awaiting_approval"]))
    await vi.waitFor(() => expect(cp.eventStreams(enrollmentId), "a waiting machine holds its doorbell").toBe(1))
    expect(await client.self()).toMatchObject({ pairingId: pairing.pairing_id, stage: "awaiting_approval", folder: "/srv/api" })
    expect(m.errors, "waiting for an answer is not a failure").toEqual([])

    const workspaceId = cp.pairings.approve(pairing.pairing_id)
    expect((await starting).status, "the approval's ring, not a timer, starts it").toBe("enrolled")
    await vi.waitFor(() => expect(m.tunnels.at(-1)).toMatchObject({ workspaceIds: [workspaceId] }))
    expect(m.scope()?.allowed_roots, "the approved folder is the machine's one root").toEqual(["/srv/api"])
    expect(m.holds).toEqual(["awaiting_approval", undefined])
    expect(await client.self()).toMatchObject({ stage: "ready", workspaceId, displayName: "build-box" })
  })

  test("a denial rings the waiting machine and stops it with the owner's answer", async () => {
    const cp = createFakeControlPlane()
    const h = await pairingHost(cp)
    const pairing = cp.pairings.create()
    const { state } = await h.redeem(pairing.code)
    const { transport, client } = h.signed(state)
    const m = pairedConnector(state, transport)
    const starting = m.connector.start()
    await vi.waitFor(() => expect(cp.eventStreams(state.enrollment?.enrollment_id ?? "")).toBe(1))

    cp.pairings.deny(pairing.pairing_id)
    expect(await starting).toMatchObject({ status: "stopped", reason: "revoked" })
    expect(m.errors.map((error) => (error as { code?: string }).code)).toEqual(["enrollment_denied"])
    expect(await client.self().catch((error: unknown) => (error as { code?: string }).code)).toBe("enrollment_denied")
  })

  test("a machine nobody answers within the wait is told so on its next ask", async () => {
    let now = 1_000_000
    const cp = createFakeControlPlane({ now: () => now })
    const h = await pairingHost(cp, () => now)
    const pairing = cp.pairings.create()
    const { state } = await h.redeem(pairing.code)
    const { transport } = h.signed(state)
    const m = pairedConnector(state, transport)
    const starting = m.connector.start()
    await vi.waitFor(() => expect(m.holds).toEqual(["awaiting_approval"]))

    now += 15 * 60_000 + 1
    m.tick()
    expect(await starting).toMatchObject({ status: "stopped", reason: "revoked" })
    expect(m.errors.map((error) => (error as { code?: string }).code)).toEqual(["enrollment_approval_expired"])
    expect(() => cp.pairings.approve(pairing.pairing_id), "an answer after the wait is refused").toThrow("pairing_expired")
  })
})

describe("a connected machine asking to share another folder", () => {
  test("its owner's approval adds the folder to its roots and assigns it", async () => {
    const cp = createFakeControlPlane()
    const enrolled = await enrollFakeHost(cp, { allowedRoots: ["/srv/api"] })
    const options = { controlPlaneUrl: cp.url, keys: enrolled.keys, enrollmentId: enrolled.enrollmentId, hostId: enrolled.state.host_id, fetch: cp.fetch }
    const client = createMachinePairingClient(options)
    const pairing = cp.pairings.create()

    const asked = await client.requestFolder({ code: pairing.code, folder: "/home/u/web/", home: "/home/u" })
    expect(asked).toMatchObject({ pairing: { stage: "awaiting_approval", folder: "/home/u/web" }, approvalUrl: `${cp.url}/settings/machines` })
    expect(cp.enrollments.get(enrolled.enrollmentId)?.approval_requested_at, "asking does not hold a machine already serving").toBeUndefined()

    const workspaceId = cp.pairings.approve(pairing.pairing_id)
    expect(cp.enrollments.get(enrolled.enrollmentId)?.scope?.allowed_roots).toEqual(["/srv/api", "/home/u/web"])
    expect(cp.assignments.get(workspaceId)).toMatchObject({ remote_directory: "/home/u/web", display_name: "web" })
    expect(await client.self()).toMatchObject({ stage: "approved", folder: "/home/u/web" })
  })

  test("a denied folder leaves the machine as it was, and a code minted by someone else is not this machine's", async () => {
    const cp = createFakeControlPlane()
    const enrolled = await enrollFakeHost(cp, { allowedRoots: ["/srv/api"] })
    const client = createMachinePairingClient({ controlPlaneUrl: cp.url, keys: enrolled.keys, enrollmentId: enrolled.enrollmentId, hostId: enrolled.state.host_id, fetch: cp.fetch })
    const pairing = cp.pairings.create()
    await client.requestFolder({ code: pairing.code, folder: "/home/u/web" })
    cp.pairings.deny(pairing.pairing_id)
    expect(cp.enrollments.get(enrolled.enrollmentId)).toMatchObject({ scope: { allowed_roots: ["/srv/api"] } })
    expect(cp.enrollments.get(enrolled.enrollmentId)?.revoked_at).toBeUndefined()
    expect(await client.self()).toMatchObject({ stage: "denied" })

    const bobs = cp.pairings.create({ owner: "bob" })
    const refused = await client.requestFolder({ code: bobs.code, folder: "/home/u/web" }).catch((error: unknown) => error)
    expect((refused as { code?: string }).code).toBe("pairing_invalid")
  })
})
