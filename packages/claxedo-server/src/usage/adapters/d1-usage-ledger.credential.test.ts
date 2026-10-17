import { afterEach, describe, expect, test, vi } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import type { credentialSpend } from "@claxedo/server-core/usage/credential-spend"
import type { TurnUsageCredential, TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { createD1UsageLedger } from "./d1-usage-ledger"

type CredentialSpendResponse = { scope: string; credentials: Awaited<ReturnType<typeof credentialSpend>> }

const databases: ControlPlaneDatabase[] = []

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.dispose()))
})

const DAY = Date.parse("2026-10-16T10:00:00Z")
const ALICE = { org_id: "org_acme", user_id: "user_alice" }
const BOB = { org_id: "org_acme", user_id: "user_bob" }
const RANGE = { since: DAY - 1, until: DAY + 10_000 }

async function credentialRow(database: D1Database, row: { id: string; owner: string | null; orgId?: string; kind?: string; label?: string; providerId?: string }) {
  await database.prepare(`
    insert into hosted_provider_credentials (id, owner, org_id, provider_id, kind, source, label, status, secret_envelope, revision, created_at, updated_at)
    values (?, ?, ?, ?, ?, 'managed', ?, 'available', 'cenc1:x', 1, 1, 1)
  `).bind(row.id, row.owner, row.orgId ?? "org_acme", row.providerId ?? "anthropic", row.kind ?? "api_key", row.label ?? null).run()
}

/** Alice founded org_acme, Bob is a member, and each holds a personal account beside the org's team key. */
async function organization() {
  const handle = await miniflareControlPlaneDatabase()
  databases.push(handle)
  const { database } = handle
  await database.batch([
    database.prepare("insert into users (user_id, state, created_at, updated_at) values ('user_alice', 'active', 1, 1), ('user_bob', 'active', 1, 1)"),
    database.prepare("insert into orgs (org_id, name, kind, owner_user_id, created_at, updated_at) values ('org_acme', 'Acme', 'shared', 'user_alice', 1, 1)"),
    database.prepare("insert into org_memberships (org_id, user_id, role, created_at, updated_at) values ('org_acme', 'user_alice', 'owner', 1, 1), ('org_acme', 'user_bob', 'member', 1, 1)"),
  ])
  await credentialRow(database, { id: "cred_alice_plan", owner: "user_alice", kind: "oauth_token", label: "Alice's plan", providerId: "claude-sdk" })
  await credentialRow(database, { id: "cred_bob_key", owner: "user_bob", label: "Bob's key" })
  await credentialRow(database, { id: "cred_team", owner: null, label: "Team key" })
  await credentialRow(database, { id: "cred_boat", owner: null, kind: "sandbox_driver", providerId: "boat" })
  await credentialRow(database, { id: "cred_elsewhere", owner: null, orgId: "org_other" })
  return { database, ledger: createD1UsageLedger({ database, now: () => 7_000 }) }
}

function turn(messageId: string, credential: TurnUsageCredential | undefined, output = 100): TurnUsageRevision {
  return {
    sessionRef: "workspace:ws_main:session:ses_1",
    sessionId: "ses_1",
    workspaceId: "ws_main",
    hostId: "workspace:ws_main",
    location: "cloud-workspace",
    messageId,
    revision: 1,
    observedAt: DAY,
    completedAt: DAY + 1_000,
    settlement: "final",
    status: "completed",
    harness: "claude",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    tokens: { input: 1_000, output, reasoning: null, cache: { read: null, write: null } },
    quality: { source: "provider", knownCategories: ["input", "output"] },
    ...(credential ? { credential } : {}),
  }
}

const stored = (credentialId: string): TurnUsageCredential => ({ kind: "stored", credentialId })

async function filed(database: D1Database) {
  const rows = await database.prepare(
    "select message_id, credential_source, credential_id, credential_kind, credential_owner from usage_turn_facts order by message_id",
  ).all()
  return rows.results
}

describe("the credential a filed turn records", () => {
  test("is the stored row its owner may spend, with the row's own source and kind, and anything else is named for what it is", async () => {
    const { database, ledger } = await organization()
    const file = (messageId: string, credential: TurnUsageCredential | undefined) =>
      ledger.writeRevision(turn(messageId, credential), { owner: ALICE, turnId: messageId })

    await file("m1_own_plan", stored("cred_alice_plan"))
    await file("m2_team_key", stored("cred_team"))
    await file("m3_bobs_key", stored("cred_bob_key"))
    await file("m4_sandbox_key", stored("cred_boat"))
    await file("m5_other_org", stored("cred_elsewhere"))
    await file("m6_deleted", stored("cred_gone"))
    await file("m7_machine_login", { kind: "machine" })
    await file("m8_unnamed", undefined)

    expect(await filed(database)).toEqual([
      { message_id: "m1_own_plan", credential_source: "personal", credential_id: "cred_alice_plan", credential_kind: "oauth_token", credential_owner: "user_alice" },
      { message_id: "m2_team_key", credential_source: "org", credential_id: "cred_team", credential_kind: "api_key", credential_owner: null },
      { message_id: "m3_bobs_key", credential_source: "unresolved", credential_id: null, credential_kind: null, credential_owner: null },
      { message_id: "m4_sandbox_key", credential_source: "unresolved", credential_id: null, credential_kind: null, credential_owner: null },
      { message_id: "m5_other_org", credential_source: "unresolved", credential_id: null, credential_kind: null, credential_owner: null },
      { message_id: "m6_deleted", credential_source: "unresolved", credential_id: null, credential_kind: null, credential_owner: null },
      { message_id: "m7_machine_login", credential_source: "machine", credential_id: null, credential_kind: null, credential_owner: null },
      { message_id: "m8_unnamed", credential_source: "unreported", credential_id: null, credential_kind: null, credential_owner: null },
    ])
    const facts = await ledger.cloudUsageFacts({ ...ALICE, ...RANGE, limit: 10 })
    expect(Object.fromEntries(facts.map((fact) => [fact.messageId, fact.credential]))).toEqual({
      m1_own_plan: stored("cred_alice_plan"),
      m2_team_key: stored("cred_team"),
      m3_bobs_key: undefined,
      m4_sandbox_key: undefined,
      m5_other_org: undefined,
      m6_deleted: undefined,
      m7_machine_login: { kind: "machine" },
      m8_unnamed: undefined,
    })
  })

  test("is part of the revision's identity: a replay naming it again is a duplicate, one naming another credential a conflict", async () => {
    const { ledger } = await organization()
    const filing = { owner: ALICE, turnId: "t1" }
    expect(await ledger.writeRevision(turn("m1", stored("cred_team")), filing)).toMatchObject({ status: "accepted" })
    expect(await ledger.writeRevision(turn("m1", stored("cred_team")), filing)).toEqual({ status: "duplicate" })
    expect(await ledger.writeRevision(turn("m1", stored("cred_alice_plan")), filing)).toEqual({ status: "conflict", currentRevision: 1 })
  })
})

describe("spend per credential", () => {
  async function spentByBoth() {
    const fixture = await organization()
    const { ledger } = fixture
    await ledger.writeRevision(turn("a1", stored("cred_alice_plan"), 100), { owner: ALICE, turnId: "a1" })
    await ledger.writeRevision(turn("a2", stored("cred_team"), 200), { owner: ALICE, turnId: "a2" })
    await ledger.writeRevision(turn("a3", { kind: "machine" }, 300), { owner: ALICE, turnId: "a3" })
    await ledger.writeRevision(turn("b1", stored("cred_team"), 400), { owner: BOB, turnId: "b1" })
    await ledger.writeRevision(turn("b2", stored("cred_bob_key"), 500), { owner: BOB, turnId: "b2" })
    return fixture
  }

  const summary = (rows: readonly Record<string, unknown>[] | undefined) =>
    rows?.map((row) => [row.source, row.credential_id, row.credential_kind, row.label, row.turn_count, row.output_tokens])

  test("a person sees what they spent on each credential they ran on, their own accounts and the team's, and no one else's", async () => {
    const { ledger } = await spentByBoth()

    expect(summary(await ledger.credentialSpend({ ...ALICE, ...RANGE, scope: "mine" }))).toEqual([
      ["machine", null, null, null, 1, 300],
      ["org", "cred_team", "api_key", "Team key", 1, 200],
      ["personal", "cred_alice_plan", "oauth_token", "Alice's plan", 1, 100],
    ])
    expect(summary(await ledger.credentialSpend({ ...BOB, ...RANGE, scope: "mine" }))).toEqual([
      ["org", "cred_team", "api_key", "Team key", 1, 400],
      ["personal", "cred_bob_key", "api_key", "Bob's key", 1, 500],
    ])
  })

  test("an organization's admin sees each member's spend on the team's keys and none of their personal accounts; a member is refused", async () => {
    const { ledger } = await spentByBoth()

    const spent = await ledger.credentialSpend({ ...ALICE, ...RANGE, scope: "org" })
    expect(spent?.map((row) => [row.source, row.credential_id, row.spender, row.label, row.turn_count, row.output_tokens])).toEqual([
      ["org", "cred_team", "user_alice", "Team key", 1, 200],
      ["org", "cred_team", "user_bob", "Team key", 1, 400],
    ])
    expect((await ledger.credentialSpend({ ...ALICE, ...RANGE, scope: "mine" }))?.every((row) => row.spender === null)).toBe(true)
    expect(await ledger.credentialSpend({ ...BOB, ...RANGE, scope: "org" })).toBeUndefined()
  })

  test("the usage API answers each credential priced by its models, and refuses the team's spend to a member", async () => {
    const { ledger } = await spentByBoth()
    const orgMembers = vi.fn(async () => [{ userId: "user_alice", name: "Alice Liddell" }])
    const as = (identity: typeof ALICE) => UsageRoutes({ ledger, identity: async () => identity, orgMembers, pricing: tokenTrackerPricing("bundled") })
    const read = (identity: typeof ALICE, query: string) => as(identity).request(`/credentials?since=${RANGE.since}&until=${RANGE.until}${query}`)

    const mine = await read(ALICE, "")
    expect(mine.status).toBe(200)
    const body = await mine.json() as CredentialSpendResponse
    expect(body.scope).toBe("mine")
    expect(body.credentials.map(({ source, credentialId, kind, label, providerId, turnCount, output }) => ({ source, credentialId, kind, label, providerId, turnCount, output })))
      .toEqual(expect.arrayContaining([
        { source: "personal", credentialId: "cred_alice_plan", kind: "oauth_token", label: "Alice's plan", providerId: "claude-sdk", turnCount: 1, output: 100 },
        { source: "org", credentialId: "cred_team", kind: "api_key", label: "Team key", providerId: "anthropic", turnCount: 1, output: 200 },
        { source: "machine", credentialId: undefined, kind: undefined, label: undefined, providerId: undefined, turnCount: 1, output: 300 },
      ]))
    expect(body.credentials.every((spend) => spend.estimatedUsd > 0 && spend.unpricedTokens === 0)).toBe(true)
    expect(body.credentials.map((spend) => spend.estimatedUsd)).toEqual(body.credentials.map((spend) => spend.estimatedUsd).toSorted((a, b) => b - a))
    expect(body.credentials.some((spend) => "members" in spend)).toBe(false)

    const team = await (await read(ALICE, "&scope=org")).json() as CredentialSpendResponse
    expect(team.credentials).toEqual([expect.objectContaining({ source: "org", credentialId: "cred_team", turnCount: 2, output: 600 })])
    const [teamKey] = team.credentials
    expect(teamKey?.members?.map(({ userId, name, former, turnCount, output }) => ({ userId, name, former, turnCount, output }))).toEqual([
      { userId: "user_bob", name: undefined, former: true, turnCount: 1, output: 400 },
      { userId: "user_alice", name: "Alice Liddell", former: undefined, turnCount: 1, output: 200 },
    ])
    expect(teamKey?.members?.every((member) => member.estimatedUsd > 0)).toBe(true)
    expect(teamKey?.members?.reduce((total, member) => total + member.estimatedUsd, 0)).toBeCloseTo(teamKey?.estimatedUsd ?? 0, 10)
    const refused = await read(BOB, "&scope=org")
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: { code: "usage_scope_forbidden", message: expect.any(String) } })
    expect((await read(ALICE, "&scope=everyone")).status).toBe(400)
    expect(orgMembers).toHaveBeenCalledTimes(1)
  })
})
