import { afterAll, beforeAll, expect, test } from "vitest"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { parseTurnDelivery } from "@claxedo/harness/contract"
import { sessionAccountCredentials } from "@claxedo/harness/registry"
import { sessionHostPlane, type SessionHostPlane } from "../test-support/session-host-plane"

/** A Pi session whose creator chose their organization's Anthropic account: what each turn is handed, and what it says once the account is gone. */

let plane: SessionHostPlane
const ROOT = "ses_pi_team"
const ANTHROPIC = ["anthropic", "claude-sdk", "claude-acp"]

beforeAll(async () => {
  plane = await sessionHostPlane()
  await plane.credentials(plane.orgId).putCredential({ owner: plane.owner.principal!.userId, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-own" })
  await plane.createHostedSession(ROOT)
})

afterAll(async () => {
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

test("a person on the team account is handed it, not their own key, and its refusal by the vendor counts against it", async () => {
  const ownerId = plane.owner.principal!.userId
  const accounts = plane.credentials(plane.orgId)
  const team = await accounts.putCredential({ owner: null, provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-team", label: "Team" })
  await accounts.setAccountSources(ANTHROPIC, "org", plane.orgId, ownerId)

  const { lease, delivery } = await delivered("turn_team")
  expect(delivery.auth.direct).toEqual({
    [ownerId]: { anthropic: expect.objectContaining({ secret: "sk-ant-api03-team", account: { credentialId: team.id, providerId: "anthropic", label: "Team" } }) },
  })
  expect(piTurn(delivery.auth).direct?.anthropic?.account?.credentialId).toBe(team.id)

  const refused = await plane.post("/turn-credential-refused", { turnLease: lease.leaseId, credentialId: team.id })
  expect(refused.status).toBe(200)
  expect(await refused.json()).toEqual({ refusal: "waiting" })
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
