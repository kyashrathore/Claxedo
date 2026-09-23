import { afterEach, describe, expect, test } from "vitest"
import { LocalUsageRoutes, createUsageOutboxSync } from "@claxedo/local-server/self-hosted-execution"
import type { UsageReportFact, UsageReportRevision } from "@claxedo/server-core/usage/usage-report"
import { usageReportPlane, type UsageReportPlane } from "../test-support/usage-report-plane"

const planes: UsageReportPlane[] = []

afterEach(() => {
  for (const plane of planes.splice(0)) plane.close()
})

async function plane(input: { usageWriter?: boolean } = {}) {
  const created = await usageReportPlane(input)
  planes.push(created)
  return created
}

const OBSERVED_AT = Date.parse("2026-09-20T10:00:00Z")

const REVISION: UsageReportRevision = {
  messageId: "msg_assistant_1",
  revision: 2,
  observedAt: OBSERVED_AT,
  completedAt: OBSERVED_AT + 5_000,
  settlement: "final",
  status: "completed",
  harness: "codex",
  providerId: "anthropic",
  modelId: "claude-sonnet-5",
  tokens: { input: 1_000, output: 200, reasoning: null, cache: { read: 300, write: 80, write1h: 50 } },
  quality: { source: "provider", observationKind: "cumulative", knownCategories: ["input", "output", "cache_read", "cache_write"] },
}

function reported(input: Partial<UsageReportFact> = {}): UsageReportFact {
  return { ...REVISION, turnId: "msg_user_1", ...input }
}

async function filedFor(target: UsageReportPlane, userId: "owner" | "member") {
  const filed = await target.ledger.pendingOutbox({ all: true, owner: { org_id: target.orgId, user_id: userId } })
  return filed.map((fact) => fact.messageId)
}

type Lease = Awaited<ReturnType<UsageReportPlane["acquire"]>>

function report(target: UsageReportPlane, lease: Lease, facts: unknown[], extra: Record<string, unknown> = {}) {
  return target.post({ action: "usage_report", ...lease, facts, ...extra })
}

describe("usage reports over the runtime session authority", () => {
  test("files a revision under the lease's session and workspace, owned by the turn's producer, and answers replays by revision", async () => {
    const target = await plane()
    await target.session("ses_report")
    const lease = await target.acquire(target.owner, "ses_report", "msg_user_1")

    const accepted = await report(target, lease, [reported()])
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ results: [{ messageId: "msg_assistant_1", revision: 2, status: "accepted" }] })

    const replayed = await report(target, lease, [reported()])
    expect(await replayed.json()).toEqual({ results: [{ messageId: "msg_assistant_1", revision: 2, status: "duplicate" }] })
    const rewritten = await report(target, lease, [reported({ tokens: { input: 9, output: 9, reasoning: null, cache: { read: 0, write: 0 } } })])
    expect(await rewritten.json()).toEqual({ results: [{ messageId: "msg_assistant_1", revision: 2, status: "conflict", currentRevision: 2 }] })
    const older = await report(target, lease, [reported({ revision: 1, settlement: "provisional", status: "running" })])
    expect(await older.json()).toEqual({ results: [{ messageId: "msg_assistant_1", revision: 1, status: "stale", currentRevision: 2 }] })

    expect(await target.ledger.current({ sessionId: "ses_report" })).toEqual([{
      sessionId: "ses_report",
      sessionRef: "workspace:ws_real:session:ses_report",
      workspaceId: "ws_real",
      hostId: "workspace:ws_real",
      location: "cloud-workspace",
      messageId: "msg_assistant_1",
      revision: 2,
      observedAt: OBSERVED_AT,
      completedAt: OBSERVED_AT + 5_000,
      settlement: "final",
      status: "completed",
      harness: "codex",
      providerId: "anthropic",
      modelId: "claude-sonnet-5",
      tokens: { input: 1_000, output: 200, reasoning: null, cache: { read: 300, write: 80, write1h: 50 } },
      quality: { source: "provider", observationKind: "cumulative", knownCategories: ["input", "output", "cache_read", "cache_write"] },
    }])
    expect(await filedFor(target, "owner")).toEqual(["msg_assistant_1"])
    expect(await filedFor(target, "member")).toEqual([])
  })

  test("files each fact under the producer of the turn it names, whichever turn's lease carries the report", async () => {
    const target = await plane()
    await target.session("ses_shared")
    const ownerTurn = await target.acquire(target.owner, "ses_shared", "msg_user_owner")
    expect((await target.post({ action: "turn_release", ...ownerTurn })).status).toBe(200)
    const memberTurn = await target.acquire(target.member, "ses_shared", "msg_user_member")

    const carried = await report(target, memberTurn, [
      reported({ messageId: "msg_by_owner", turnId: "msg_user_owner" }),
      reported({ messageId: "msg_by_member", turnId: "msg_user_member" }),
    ])
    expect(await carried.json()).toEqual({ results: [
      { messageId: "msg_by_owner", revision: 2, status: "accepted" },
      { messageId: "msg_by_member", revision: 2, status: "accepted" },
    ] })
    const late = await report(target, ownerTurn, [reported({ messageId: "msg_late_by_owner", turnId: "msg_user_owner" })])
    expect(await late.json()).toEqual({ results: [{ messageId: "msg_late_by_owner", revision: 2, status: "accepted" }] })

    expect(await filedFor(target, "owner")).toEqual(["msg_by_owner", "msg_late_by_owner"])
    expect(await filedFor(target, "member")).toEqual(["msg_by_member"])
  })

  test("refuses, fact by fact, a fact naming a turn its session never admitted", async () => {
    const target = await plane()
    await target.session("ses_reported")
    await target.session("ses_elsewhere")
    const elsewhere = await target.acquire(target.owner, "ses_elsewhere", "msg_user_elsewhere")
    expect((await target.post({ action: "turn_release", ...elsewhere })).status).toBe(200)
    const lease = await target.acquire(target.member, "ses_reported", "msg_user_1")

    const answer = await report(target, lease, [
      reported({ messageId: "msg_own_turn" }),
      reported({ messageId: "msg_other_session_turn", turnId: "msg_user_elsewhere" }),
      reported({ messageId: "msg_unknown_turn", turnId: "msg_user_never" }),
    ])
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ results: [
      { messageId: "msg_own_turn", revision: 2, status: "accepted" },
      { messageId: "msg_other_session_turn", revision: 2, status: "refused", code: "usage_owner_unresolved" },
      { messageId: "msg_unknown_turn", revision: 2, status: "refused", code: "usage_owner_unresolved" },
    ] })

    expect((await target.ledger.current({ sessionId: "ses_reported" })).map((fact) => fact.messageId)).toEqual(["msg_own_turn"])
    expect(await target.ledger.current({ sessionId: "ses_elsewhere" })).toEqual([])
    expect(await filedFor(target, "member")).toEqual(["msg_own_turn"])
    expect(await filedFor(target, "owner")).toEqual([])
  })

  test("refuses a report whose turn proof does not verify, and stores nothing", async () => {
    const target = await plane()
    await target.session("ses_proof")
    const lease = await target.acquire(target.owner, "ses_proof", "msg_user_1")

    for (const forged of [
      { ...lease, fencingToken: lease.fencingToken + 1 },
      { ...lease, turnId: "msg_user_other" },
      { ...lease, sessionId: "ses_other" },
      { ...lease, leaseId: "not-a-lease" },
    ]) {
      const refused = await report(target, forged, [reported()])
      expect(refused.status).toBe(401)
      expect(await refused.json()).toMatchObject({ error: { code: "session_turn_lease_invalid" } })
    }
    const bearerOnly = await target.post(
      { action: "usage_report", sessionId: "ses_proof", turnId: "msg_user_1", fencingToken: lease.fencingToken, facts: [reported()] },
      await target.relayToken(target.owner),
    )
    expect(bearerOnly.status).toBe(400)

    target.revokeRuntimeAccessToken()
    const revoked = await report(target, lease, [reported()])
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })

    expect(await target.ledger.current({ sessionId: "ses_proof" })).toEqual([])
  })

  test("refuses a report that names a location, host, session, workspace or owner, and stores nothing", async () => {
    const target = await plane()
    await target.session("ses_forged")
    const lease = await target.acquire(target.owner, "ses_forged", "msg_user_1")

    for (const field of [
      { location: "local" },
      { hostId: "host_attacker" },
      { sessionRef: "local:/tmp:session:ses_forged" },
      { sessionId: "ses_other" },
      { workspaceId: "ws_other" },
      { org_id: "org_attacker" },
      { user_id: "attacker" },
    ]) {
      const refused = await report(target, lease, [{ ...reported(), ...field }])
      expect(refused.status, JSON.stringify(field)).toBe(400)
      expect(await refused.json()).toMatchObject({ error: { code: "usage_report_invalid" } })
    }
    for (const field of [{ workspaceId: "ws_other" }, { hostId: "host_attacker" }, { owner: { org_id: "org_attacker", user_id: "attacker" } }]) {
      expect((await report(target, lease, [reported()], field)).status, JSON.stringify(field)).toBe(400)
    }
    expect((await report(target, lease, [reported({ revision: 0 })])).status).toBe(400)
    expect((await report(target, lease, [REVISION])).status).toBe(400)
    expect((await report(target, lease, [reported({ turnId: "" })])).status).toBe(400)
    expect((await report(target, lease, [])).status).toBe(400)

    expect(await target.ledger.current({ sessionId: "ses_forged" })).toEqual([])
  })

  test("a plane with no usage store answers a verified report as unavailable", async () => {
    const target = await plane({ usageWriter: false })
    await target.session("ses_unstored")
    const lease = await target.acquire(target.owner, "ses_unstored", "msg_user_1")

    const answer = await report(target, lease, [reported()])
    expect(answer.status).toBe(503)
    expect(await answer.json()).toMatchObject({ error: { code: "usage_report_unavailable" } })
  })
})

describe("the self-hosted usage view over reported cloud turns", () => {
  test("shows the producer their cloud turns beside their local ones, and nobody else", async () => {
    const target = await plane()
    await target.session("ses_view")
    const lease = await target.acquire(target.owner, "ses_view", "msg_user_1")
    expect((await report(target, lease, [reported({ messageId: "msg_view" })])).status).toBe(200)
    await target.ledger.writeRevision({
      ...REVISION,
      messageId: "msg_local",
      tokens: { input: 10, output: 5, reasoning: null, cache: { read: null, write: null } },
      sessionId: "ses_local",
      sessionRef: "local:/work:session:ses_local",
      hostId: "host_this_machine",
      location: "local",
    }, { owner: { org_id: target.orgId, user_id: "owner" } })

    const identities: Record<string, { org_id: string; user_id: string }> = {
      owner: { org_id: target.orgId, user_id: "owner" },
      member: { org_id: target.orgId, user_id: "member" },
      outsider: { org_id: target.outsiderOrgId, user_id: "outsider" },
    }
    const routes = LocalUsageRoutes({
      local: target.ledger,
      outbox: createUsageOutboxSync({ local: target.ledger }),
      identity: async (request) => identities[request.headers.get("x-test-user") ?? ""],
      machineOperator: () => false,
    })
    const read = async (user: string) => {
      const since = OBSERVED_AT - 86_400_000
      const response = await routes.request(`/?since=${since}&until=${OBSERVED_AT + 86_400_000}&group=location`, {
        headers: { "x-test-user": user },
      })
      expect(response.status).toBe(200)
      return await response.json() as {
        claxedo: { totals: { turnCount: number }; locationShare: { localTokens: number; cloudTokens: number } }
        breakdown: { rows: Array<{ value: string; turnCount: number }> }
      }
    }

    const owner = await read("owner")
    expect(owner.claxedo.totals.turnCount).toBe(2)
    expect(owner.claxedo.locationShare).toEqual({ localTokens: 15, cloudTokens: 1_580 })
    expect(Object.fromEntries(owner.breakdown.rows.map((row) => [row.value, row.turnCount]))).toEqual({ cloud: 1, local: 1 })
    for (const other of ["member", "outsider"]) {
      const view = await read(other)
      expect(view.claxedo.totals.turnCount, other).toBe(0)
      expect(view.claxedo.locationShare.cloudTokens, other).toBe(0)
    }
  })
})
