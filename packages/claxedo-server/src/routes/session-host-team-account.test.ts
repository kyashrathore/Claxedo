import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { parseTurnDelivery } from "@claxedo/harness/contract"
import { sessionAccountCredentials } from "@claxedo/harness/registry"
import { sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

/** A Pi session whose creator chose their organization's Anthropic account: what each turn is handed, and what it says once the account is gone. */

let plane: SessionHostPlane
const ROOT = "ses_pi_team"
const ANTHROPIC = ["anthropic", "claude-sdk", "claude-acp"]

let vendorAnswers = 200
const vendorKeys: string[] = []

beforeAll(async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname !== "api.anthropic.com") throw new Error(`unexpected fetch ${request.url}`)
    vendorKeys.push(request.headers.get("x-api-key") ?? "")
    return vendorAnswers === 200
      ? Response.json({ data: [] })
      : Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: vendorAnswers })
  })
  plane = await sessionHostPlane()
  await plane.credentials(plane.orgId).putCredential({ owner: plane.owner.principal!.userId, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-own" })
  await plane.createHostedSession(ROOT)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await plane.close()
})

const delivered = async (turnId: string) => {
  const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId(ROOT), backing: "durable-object", jti: `rat_${turnId}` })
  await plane.database.prepare("update session_turn_leases set released_at = ? where session_id = ?").bind(Date.now(), ROOT).run()
  const lease = await plane.acquire(proof, ROOT, turnId)
  const answer = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
  expect(answer.status).toBe(200)
  return { lease, delivery: parseTurnDelivery(await answer.json())! }
}

const piTurn = (auth: NonNullable<ReturnType<typeof parseTurnDelivery>>["auth"]) =>
  sessionAccountCredentials({ ...auth, placement: "cloud", canUseOwnLogin: false, leaseGeneration: "lease" }, { kind: "person", userId: plane.owner.principal!.userId },
    { harness: { id: "pi", access: "native" }, model: { providerID: "pi", modelID: "anthropic/claude-sonnet-4-5" } })

test("a person on the team account is handed it, not their own key, and a reported vendor refusal marks it only when the plane's own check of the current key agrees", async () => {
  const ownerId = plane.owner.principal!.userId
  const accounts = plane.credentials(plane.orgId)
  const team = await accounts.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team", label: "Team" })
  await accounts.setAccountSources(ANTHROPIC, "org", plane.orgId, ownerId)

  const { lease, delivery } = await delivered("turn_team")
  expect(delivery.auth.direct).toEqual({
    [ownerId]: { anthropic: expect.objectContaining({ secret: "sk-ant-api03-team", account: { credentialId: team.id, providerId: "anthropic", label: "Team", revision: team.revision } }) },
  })
  expect(piTurn(delivery.auth).direct?.anthropic?.account?.credentialId).toBe(team.id)

  const report = async (body: { revision: number; status: number }) =>
    await (await plane.post("/turn-credential-refused", { turnLease: lease.leaseId, credentialId: team.id, ...body })).json()
  const health = async () => (await accounts.getCredential!(team.id))?.health ?? null

  expect(await report({ revision: team.revision, status: 403 })).toEqual({ refusal: "ignored" })
  expect(await report({ revision: team.revision + 1, status: 401 })).toEqual({ refusal: "stale" })
  vendorAnswers = 200
  for (let attempt = 0; attempt < 3; attempt++) expect(await report({ revision: team.revision, status: 401 })).toEqual({ refusal: "kept" })
  expect(await health()).toBe("ok")
  expect(vendorKeys).toEqual(["sk-ant-api03-team", "sk-ant-api03-team", "sk-ant-api03-team"])
  vendorAnswers = 401
  expect(await report({ revision: team.revision, status: 401 })).toEqual({ refusal: "marked" })
  expect(await health()).toBe("auth_failed")
})

test("once the team account is removed the turn is refused in words that say so, and nothing is handed over in its place", async () => {
  const accounts = plane.credentials(plane.orgId)
  const [team] = (await accounts.listCredentials()).filter((row) => row.owner === null)
  await accounts.deleteCredential(team!.id)

  const { delivery } = await delivered("turn_team_removed")
  const ownerId = plane.owner.principal!.userId
  expect(delivery.auth.direct).toEqual({ [ownerId]: {} })
  expect(delivery.auth.accounts[ownerId]).toMatchObject({ anthropic: { unavailable: true, reason: "org_account_unavailable" } })
  expect(() => piTurn(delivery.auth)).toThrow("Your organization has no Anthropic API key, and this harness is set to use the organization's account. Ask an admin to add a team key, or choose your own account in Settings → Models.")
})

test("a session whose workspace owner no longer stands in the organization is handed no account at all, the team key included", async () => {
  const accounts = plane.credentials(plane.orgId)
  await accounts.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team-again" })
  const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId(ROOT), backing: "durable-object", jti: "rat_turn_left" })
  await plane.database.prepare("update session_turn_leases set released_at = ? where session_id = ?").bind(Date.now(), ROOT).run()
  const lease = await plane.acquire(proof, ROOT, "turn_left")
  expect((await plane.post("/turn-delivery", { turnLease: lease.leaseId })).status).toBe(200)

  await plane.database.batch([
    plane.database.prepare("insert into users (user_id, state, created_at, updated_at) values ('usr_successor', 'active', 1, 1)"),
    plane.database.prepare("update orgs set owner_user_id = 'usr_successor' where org_id = ?").bind(plane.orgId),
    plane.database.prepare("update org_memberships set revoked_at = ? where user_id = ? and org_id = ?").bind(Date.now(), plane.owner.principal!.userId, plane.orgId),
  ])
  const refused = await plane.post("/turn-delivery", { turnLease: lease.leaseId })
  expect(refused.status).toBe(403)
  expect(JSON.stringify(await refused.json())).not.toContain("sk-ant")
})
