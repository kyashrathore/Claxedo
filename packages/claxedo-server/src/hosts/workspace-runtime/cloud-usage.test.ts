import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, test, vi } from "vitest"
import { remoteWorkspaceSessionAccessPolicy } from "@claxedo/workspace-runtime"
import { USAGE_REPORT_MAX_FACTS } from "@claxedo/server-core/usage/usage-report"
import { cloudWorkspaceUsage, createSandboxUsageLedger, type SandboxUsageLedger } from "./cloud-usage"
import { usageReportPlane, USAGE_REPORT_URL, type UsageReportPlane } from "../../test-support/usage-report-plane"
import { buildAssistantMessage, messageCompleted, messageUpdated, sessionUsage } from "@claxedo/workspace-runtime/projection"

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function ledgerPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cloud-usage-"))
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, "runtime", "usage.sqlite")
}

function openLedger(file: string) {
  const ledger = createSandboxUsageLedger({ path: file, workspaceId: "ws_real" })
  cleanups.push(() => ledger.close())
  return ledger
}

async function openPlane() {
  const plane = await usageReportPlane()
  cleanups.push(() => plane.close())
  return plane
}

type Fetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** `parents` maps a child session to the session it was filed under. */
function sandbox(ledger: SandboxUsageLedger, fetch: Fetch, parents: Record<string, string> = {}, flushIntervalMs?: number) {
  const usage = cloudWorkspaceUsage({
    workspaceId: "ws_real",
    ledger,
    authorityUrl: USAGE_REPORT_URL,
    policy: remoteWorkspaceSessionAccessPolicy({ url: USAGE_REPORT_URL, fetch }),
    fetch,
    ...(flushIntervalMs === undefined ? {} : { flushIntervalMs }),
  })
  usage.bindSessionConfig(() => ({
    harness: { id: "codex", access: "native" },
    model: { providerID: "openai", modelID: "gpt-5.4" },
  }))
  usage.bindSessionParents((sessionId) => parents[sessionId])
  return usage
}

function envelope(payload: AgentEventEnvelope["payload"]): AgentEventEnvelope {
  return { directory: "/workspace", payload }
}

const TOKENS = { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } }
const OBSERVED_AT = Date.now() - 60_000

function turnEvents(sessionId: string, messageId: string, input: { completed: boolean; tokens?: typeof TOKENS }) {
  const events = [
    envelope(messageUpdated(buildAssistantMessage({
      id: messageId,
      sessionID: sessionId,
      parentID: "msg_user_1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.4" },
      directory: "/workspace",
      created: 1_000,
    }))),
    envelope(sessionUsage({
      sessionID: sessionId,
      messageID: messageId,
      contextSize: 200_000,
      contextUsed: 1_500,
      observation: {
        kind: "cumulative",
        providerObservationId: `obs_${messageId}`,
        observedAt: OBSERVED_AT,
        tokens: input.tokens ?? TOKENS,
      },
    })),
  ]
  return input.completed ? [...events, envelope(messageCompleted(sessionId, messageId))] : events
}

type Account = UsageReportPlane["owner"]

async function turnAccess(plane: UsageReportPlane, sessionId: string, by: Account) {
  return {
    actor: { actorId: by.principal!.actorId, actorKind: "human" as const },
    authority: { managed: true as const, workspaceId: "ws_real", orgId: plane.orgId, role: "editor" as const },
    credential: `Bearer ${await plane.relayToken(by)}`,
    operation: "prompt" as const,
    sessionId,
  }
}

type Usage = ReturnType<typeof sandbox>

async function startTurn(plane: UsageReportPlane, usage: Usage, input: { by: Account; sessionId: string; turnId: string }) {
  const access = await turnAccess(plane, input.sessionId, input.by)
  const acquired = await usage.sessionAccessPolicy.acquireTurn!({ ...access, turnId: input.turnId })
  if (!acquired.allowed) throw new Error(`turn was refused: ${acquired.code}`)
  return { ...access, turnId: input.turnId, leaseId: acquired.leaseId, fencingToken: acquired.fencingToken }
}

/**
 * Ends a turn as the runtime's lease controller does: the policy hears the
 * turn ended, then the lease is released — unless it was lost, when the
 * authority is not asked.
 */
async function finishTurn(usage: Usage, turn: Awaited<ReturnType<typeof startTurn>>, input: { lost?: boolean } = {}) {
  await usage.sessionAccessPolicy.endTurn?.(turn)
  return input.lost ? { released: false } : await usage.sessionAccessPolicy.releaseTurn!(turn)
}

/** One turn through the runtime's own policy: acquire, the harness's events, end and release. */
async function runTurn(
  plane: UsageReportPlane,
  usage: Usage,
  input: { by: Account; sessionId: string; turnId: string; events: AgentEventEnvelope[] },
) {
  const turn = await startTurn(plane, usage, input)
  for (const event of input.events) usage.onPresentationEvent(event)
  const released = await finishTurn(usage, turn)
  await usage.drain()
  return released
}

function refusingReports(plane: UsageReportPlane, refuse: () => boolean): Fetch {
  return async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : ""
    if (refuse() && body.includes("\"usage_report\"")) return Response.json({ error: { code: "unavailable" } }, { status: 503 })
    return await plane.fetch(url, init)
  }
}

async function filedFor(plane: UsageReportPlane, userId: "owner" | "member") {
  const filed = await plane.ledger.ownedBy({ org_id: plane.orgId, user_id: plane[userId].principal!.userId })
  return filed.map((fact) => fact.messageId)
}

describe("cloud workspace usage metering", () => {
  test("meters a cloud-workspace revision from the runtime's events under the session's committed harness", async () => {
    const plane = await openPlane()
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch)

    for (const event of turnEvents("ses_metered", "msg_assistant_1", { completed: true })) usage.onPresentationEvent(event)
    await usage.drain()

    expect(await ledger.current({ sessionId: "ses_metered" })).toEqual([expect.objectContaining({
      sessionRef: "workspace:ws_real:session:ses_metered",
      workspaceId: "ws_real",
      hostId: "workspace:ws_real",
      location: "cloud-workspace",
      harness: "codex",
      providerId: "openai",
      modelId: "gpt-5.4",
      settlement: "final",
      status: "completed",
      tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } },
    })])
  })

  test("reports a session's revisions when its turn lease is released, and the plane files them under the turn's producer", async () => {
    const plane = await openPlane()
    await plane.session("ses_reported")
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch)

    const released = await runTurn(plane, usage, {
      by: plane.owner,
      sessionId: "ses_reported",
      turnId: "msg_user_1",
      events: turnEvents("ses_reported", "msg_assistant_1", { completed: true }),
    })

    expect(released).toEqual({ released: true })
    expect(ledger.pending("ses_reported")).toEqual([])
    const filed = await plane.ledger.ownedBy({ org_id: plane.orgId, user_id: plane.owner.principal!.userId })
    expect(filed).toEqual([expect.objectContaining({
      sessionId: "ses_reported",
      messageId: "msg_assistant_1",
      location: "cloud-workspace",
      hostId: "workspace:ws_real",
      harness: "codex",
      settlement: "final",
      tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } },
    })])
    expect(filed[0]).toEqual((await ledger.current({ sessionId: "ses_reported" }))[0])
  })

  test("files a turn's usage under that turn's producer when another account's later release delivers it", async () => {
    const plane = await openPlane()
    await plane.session("ses_shared")
    const ledger = openLedger(ledgerPath())
    let refuseReports = true
    const usage = sandbox(ledger, refusingReports(plane, () => refuseReports))

    await runTurn(plane, usage, {
      by: plane.owner,
      sessionId: "ses_shared",
      turnId: "msg_user_owner",
      events: turnEvents("ses_shared", "msg_by_owner", { completed: true }),
    })
    expect(await plane.ledger.current({ sessionId: "ses_shared" })).toEqual([])

    refuseReports = false
    await runTurn(plane, usage, {
      by: plane.member,
      sessionId: "ses_shared",
      turnId: "msg_user_member",
      events: turnEvents("ses_shared", "msg_by_member", { completed: true }),
    })

    expect(ledger.pending("ses_shared")).toEqual([])
    expect(await filedFor(plane, "owner")).toEqual(["msg_by_owner"])
    expect(await filedFor(plane, "member")).toEqual(["msg_by_member"])
  })

  test("meters a subagent's child session under its parent's turn, and files it under that turn's producer as its own fact", async () => {
    const plane = await openPlane()
    await plane.session("ses_parent")
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch, { ses_child: "ses_parent" })
    const childTokens = { input: 70, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }

    await runTurn(plane, usage, {
      by: plane.member,
      sessionId: "ses_parent",
      turnId: "msg_user_1",
      events: [
        ...turnEvents("ses_parent", "msg_parent_reply", { completed: true }),
        ...turnEvents("ses_child", "msg_child_reply", { completed: true, tokens: childTokens }),
      ],
    })

    expect(ledger.pending("ses_parent")).toEqual([])
    expect((await ledger.current({ sessionId: "ses_child" })).map((fact) => fact.messageId)).toEqual(["msg_child_reply"])
    expect(await plane.ledger.current({ sessionId: "ses_parent" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "msg_parent_reply", sessionRef: "workspace:ws_real:session:ses_parent", tokens: TOKENS }),
      expect.objectContaining({
        messageId: "ses_child/msg_child_reply",
        sessionRef: "workspace:ws_real:session:ses_parent",
        tokens: childTokens,
      }),
    ]))
    expect((await plane.ledger.current({ sessionId: "ses_parent" })).length).toBe(2)
    expect((await filedFor(plane, "member")).sort()).toEqual(["msg_parent_reply", "ses_child/msg_child_reply"])
    expect(await filedFor(plane, "owner")).toEqual([])
  })

  test("meters a grandchild session under the turn its root holds, and files it as its own fact", async () => {
    const plane = await openPlane()
    await plane.session("ses_family_root")
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch, { ses_family_child: "ses_family_root", ses_family_grandchild: "ses_family_child" })
    const grandchildTokens = { input: 9, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

    await runTurn(plane, usage, {
      by: plane.member,
      sessionId: "ses_family_root",
      turnId: "msg_user_1",
      events: [
        ...turnEvents("ses_family_root", "msg_root_reply", { completed: true }),
        ...turnEvents("ses_family_grandchild", "msg_grandchild_reply", { completed: true, tokens: grandchildTokens }),
      ],
    })

    expect(ledger.pending("ses_family_root")).toEqual([])
    expect((await plane.ledger.current({ sessionId: "ses_family_root" })).map((fact) => [fact.messageId, fact.tokens])).toEqual([
      ["msg_root_reply", TOKENS],
      ["ses_family_grandchild/msg_grandchild_reply", grandchildTokens],
    ])
    expect((await filedFor(plane, "member")).sort()).toEqual(["msg_root_reply", "ses_family_grandchild/msg_grandchild_reply"])
  })

  test("files a descendant's fact apart from an ancestor's even when an agent reuses the ancestor's message id", async () => {
    const plane = await openPlane()
    await plane.session("ses_acp_parent")
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch, { ses_acp_child: "ses_acp_parent", ses_acp_grandchild: "ses_acp_child" })
    const childTokens = { input: 70, output: 7, reasoning: 0, cache: { read: 0, write: 0 } }
    const grandchildTokens = { input: 9, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }

    await runTurn(plane, usage, {
      by: plane.member,
      sessionId: "ses_acp_parent",
      turnId: "msg_user_1",
      events: [
        ...turnEvents("ses_acp_parent", "msg_1", { completed: true }),
        ...turnEvents("ses_acp_child", "msg_1", { completed: true, tokens: childTokens }),
        ...turnEvents("ses_acp_grandchild", "msg_1", { completed: true, tokens: grandchildTokens }),
      ],
    })

    expect(ledger.pending("ses_acp_parent")).toEqual([])
    expect((await plane.ledger.current({ sessionId: "ses_acp_parent" })).map((fact) => [fact.messageId, fact.tokens])).toEqual([
      ["msg_1", TOKENS],
      ["ses_acp_child/msg_1", childTokens],
      ["ses_acp_grandchild/msg_1", grandchildTokens],
    ])
  })

  test("keeps usage from a session no turn was admitted on across a restart, and delivers it with the first turn its session or an ancestor ends", async () => {
    const plane = await openPlane()
    await plane.session("ses_unleased_root")
    await plane.session("ses_unrelated")
    const file = ledgerPath()
    const parents = { ses_unleased_child: "ses_unleased_root" }
    const beforeRestart = createSandboxUsageLedger({ path: file, workspaceId: "ws_real" })
    const idle = sandbox(beforeRestart, plane.fetch, parents)
    for (const event of [
      ...turnEvents("ses_unleased_root", "msg_root_unleased", { completed: true }),
      ...turnEvents("ses_unleased_child", "msg_child_unleased", { completed: true }),
      ...turnEvents("ses_unrelated", "msg_unrelated_unleased", { completed: true }),
    ]) idle.onPresentationEvent(event)
    await idle.drain()
    beforeRestart.close()

    const ledger = openLedger(file)
    const usage = sandbox(ledger, plane.fetch, parents)
    await usage.drain()
    await runTurn(plane, usage, {
      by: plane.member,
      sessionId: "ses_unleased_root",
      turnId: "msg_user_1",
      events: turnEvents("ses_unleased_root", "msg_root_reply", { completed: true }),
    })

    const delivered = ["msg_root_reply", "msg_root_unleased", "ses_unleased_child/msg_child_unleased"]
    expect((await plane.ledger.current({ sessionId: "ses_unleased_root" })).map((fact) => fact.messageId).sort()).toEqual(delivered)
    expect((await filedFor(plane, "member")).sort()).toEqual(delivered)
    expect(await plane.ledger.current({ sessionId: "ses_unrelated" })).toEqual([])
    expect((await ledger.current({ sessionId: "ses_unrelated" })).map((fact) => fact.messageId)).toEqual(["msg_unrelated_unleased"])

    await runTurn(plane, usage, { by: plane.owner, sessionId: "ses_unrelated", turnId: "msg_user_2", events: [] })
    expect((await plane.ledger.current({ sessionId: "ses_unrelated" })).map((fact) => fact.messageId)).toEqual(["msg_unrelated_unleased"])
    expect(await filedFor(plane, "owner")).toEqual(["msg_unrelated_unleased"])
  })

  test("settles a revision the plane refused, so no later release offers it again", async () => {
    const plane = await openPlane()
    await plane.session("ses_refused")
    const ledger = openLedger(ledgerPath())
    const offered: string[][] = []
    const claimsAnUnknownTurn: Fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (body.action !== "usage_report" || !Array.isArray(body.facts)) return await plane.fetch(url, init)
      const facts: Array<Record<string, unknown>> = body.facts
      offered.push(facts.map((fact) => String(fact.messageId)))
      const forged = facts.map((fact) => ({ ...fact, turnId: "msg_user_never_admitted" }))
      return await plane.fetch(url, { ...init, body: JSON.stringify({ ...body, facts: forged }) })
    }
    const usage = sandbox(ledger, claimsAnUnknownTurn)

    await runTurn(plane, usage, {
      by: plane.owner,
      sessionId: "ses_refused",
      turnId: "msg_user_1",
      events: turnEvents("ses_refused", "msg_assistant_1", { completed: true }),
    })
    expect(ledger.pending("ses_refused")).toEqual([])
    await runTurn(plane, usage, { by: plane.owner, sessionId: "ses_refused", turnId: "msg_user_2", events: [] })

    expect(offered).toEqual([["msg_assistant_1"]])
    expect(await plane.ledger.current({ sessionId: "ses_refused" })).toEqual([])
  })

  test("keeps each revision's turn across a restart, and files it under that turn's producer on another account's release", async () => {
    const plane = await openPlane()
    await plane.session("ses_retried")
    const file = ledgerPath()
    let refuseReports = true
    const flaky = refusingReports(plane, () => refuseReports)
    const beforeRestart = createSandboxUsageLedger({ path: file, workspaceId: "ws_real" })
    await runTurn(plane, sandbox(beforeRestart, flaky), {
      by: plane.owner,
      sessionId: "ses_retried",
      turnId: "msg_user_1",
      events: turnEvents("ses_retried", "msg_assistant_1", { completed: false }),
    })
    expect(beforeRestart.pending("ses_retried").map(({ fact }) => [fact.settlement, fact.turnId])).toEqual([["provisional", "msg_user_1"]])
    expect(await plane.ledger.current({ sessionId: "ses_retried" })).toEqual([])
    beforeRestart.close()

    refuseReports = false
    const afterRestart = openLedger(file)
    const usage = sandbox(afterRestart, flaky)
    await usage.drain()
    expect(afterRestart.pending("ses_retried").map(({ fact }) => [fact.settlement, fact.turnId])).toEqual([["partial", "msg_user_1"]])
    await runTurn(plane, usage, { by: plane.member, sessionId: "ses_retried", turnId: "msg_user_2", events: [] })

    expect(afterRestart.pending("ses_retried")).toEqual([])
    expect(await plane.ledger.current({ sessionId: "ses_retried" })).toEqual([expect.objectContaining({
      messageId: "msg_assistant_1",
      settlement: "partial",
      status: "process_lost",
      location: "cloud-workspace",
      tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } },
    })])
    expect(await filedFor(plane, "owner")).toEqual(["msg_assistant_1"])
    expect(await filedFor(plane, "member")).toEqual([])
  })
})

async function until(condition: () => Promise<boolean> | boolean, what: string) {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function usageEvent(sessionId: string, messageId: string, scope: string, tokens: typeof TOKENS) {
  return envelope(sessionUsage({
    sessionID: sessionId,
    messageID: messageId,
    contextSize: 200_000,
    contextUsed: 1_500,
    observation: { kind: "cumulative", scope, providerObservationId: `obs_${scope}`, observedAt: OBSERVED_AT, tokens },
  }))
}

describe("cloud workspace usage delivery", () => {
  test("reports a turn whose lease was lost, and files what its harness meters while winding down under that turn", async () => {
    const plane = await openPlane()
    await plane.session("ses_lost")
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch)

    const turn = await startTurn(plane, usage, { by: plane.member, sessionId: "ses_lost", turnId: "msg_user_1" })
    for (const event of turnEvents("ses_lost", "msg_before_loss", { completed: true })) usage.onPresentationEvent(event)
    expect(await finishTurn(usage, turn, { lost: true })).toEqual({ released: false })
    await until(async () => (await filedFor(plane, "member")).includes("msg_before_loss"), "the lost turn's report")
    for (const event of turnEvents("ses_lost", "msg_after_loss", { completed: true })) usage.onPresentationEvent(event)
    await usage.drain()

    expect(await filedFor(plane, "member")).toEqual(["msg_before_loss", "msg_after_loss"])
    expect(ledger.pending("ses_lost")).toEqual([])
  })

  test("files usage that lands between two turns under the turn that left it, across a restart, when another account's turn ships it", async () => {
    const plane = await openPlane()
    await plane.session("ses_between")
    const file = ledgerPath()
    const beforeRestart = createSandboxUsageLedger({ path: file, workspaceId: "ws_real" })
    await runTurn(plane, sandbox(beforeRestart, plane.fetch), {
      by: plane.owner,
      sessionId: "ses_between",
      turnId: "msg_user_1",
      events: turnEvents("ses_between", "msg_owner_reply", { completed: true }),
    })
    beforeRestart.close()

    const ledger = openLedger(file)
    const usage = sandbox(ledger, plane.fetch)
    for (const event of turnEvents("ses_between", "msg_owner_tail", { completed: true })) usage.onPresentationEvent(event)
    await runTurn(plane, usage, {
      by: plane.member,
      sessionId: "ses_between",
      turnId: "msg_user_2",
      events: turnEvents("ses_between", "msg_member_reply", { completed: true }),
    })

    expect(await filedFor(plane, "owner")).toEqual(["msg_owner_reply", "msg_owner_tail"])
    expect(await filedFor(plane, "member")).toEqual(["msg_member_reply"])
    expect(ledger.pending("ses_between")).toEqual([])
  })

  test("ships a revision written after its turn ended under that turn's unexpired lease, with no later turn", async () => {
    const plane = await openPlane()
    await plane.session("ses_tail")
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch, {}, 10)

    const turn = await startTurn(plane, usage, { by: plane.owner, sessionId: "ses_tail", turnId: "msg_user_1" })
    for (const event of turnEvents("ses_tail", "msg_assistant_1", { completed: false })) usage.onPresentationEvent(event)
    await finishTurn(usage, turn)
    await until(async () => (await plane.ledger.current({ sessionId: "ses_tail" }))[0]?.settlement === "provisional", "the turn's revision")
    usage.onPresentationEvent(envelope(messageCompleted("ses_tail", "msg_assistant_1")))

    await until(async () => (await plane.ledger.current({ sessionId: "ses_tail" }))[0]?.settlement === "final", "the tail revision")
    await usage.drain()
    expect(ledger.pending("ses_tail")).toEqual([])
    expect(await filedFor(plane, "owner")).toEqual(["msg_assistant_1"])
  })

  test("a batch the plane cannot read holds back no other batch of the report", async () => {
    const plane = await openPlane()
    await plane.session("ses_batches")
    const ledger = openLedger(ledgerPath())
    const offered: string[][] = []
    const unreadable: string[] = []
    const refusesOneBatch: Fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
      if (body.action !== "usage_report" || !Array.isArray(body.facts)) return await plane.fetch(url, init)
      const facts: Array<Record<string, unknown>> = body.facts
      const batch = facts.map((fact) => String(fact.messageId))
      offered.push(batch)
      if (!batch.includes("msg_00")) return await plane.fetch(url, init)
      unreadable.push(...batch)
      return Response.json({ error: { code: "usage_report_invalid" } }, { status: 400 })
    }
    const usage = sandbox(ledger, refusesOneBatch)
    const messages = Array.from({ length: USAGE_REPORT_MAX_FACTS + 4 }, (_, index) => `msg_${String(index).padStart(2, "0")}`)

    await runTurn(plane, usage, {
      by: plane.owner,
      sessionId: "ses_batches",
      turnId: "msg_user_1",
      events: messages.flatMap((messageId) => turnEvents("ses_batches", messageId, { completed: true })),
    })

    const refused = [...new Set(unreadable)].sort()
    expect(offered[0]).toContain("msg_00")
    expect(refused.length).toBeGreaterThan(0)
    expect((await filedFor(plane, "owner")).sort()).toEqual(messages.filter((messageId) => !refused.includes(messageId)))
    expect(ledger.pending("ses_batches").map(({ messageId }) => messageId).sort()).toEqual(refused)
    expect(offered.every((batch) => batch.length <= USAGE_REPORT_MAX_FACTS)).toBe(true)
  })

  test("admits and releases turns while its store fails, so the session takes its next turn", async () => {
    const plane = await openPlane()
    await plane.session("ses_full")
    const ledger = openLedger(ledgerPath())
    const full = (): never => { throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }) }
    const failing: SandboxUsageLedger = { ...ledger, recordTurn: full, adoptUnattributed: full, pending: full }
    const usage = sandbox(failing, plane.fetch)

    const turn = await startTurn(plane, usage, { by: plane.owner, sessionId: "ses_full", turnId: "msg_user_1" })
    for (const event of turnEvents("ses_full", "msg_assistant_1", { completed: true })) usage.onPresentationEvent(event)
    expect(await finishTurn(usage, turn)).toEqual({ released: true })
    await usage.drain()

    const next = await startTurn(plane, usage, { by: plane.member, sessionId: "ses_full", turnId: "msg_user_2" })
    expect(next.fencingToken).toBeGreaterThan(turn.fencingToken)
    await finishTurn(usage, next)
    await usage.drain()
  })

  test("keeps each scope's running usage across a restart, so a later cumulative replaces only its own scope", async () => {
    const plane = await openPlane()
    await plane.session("ses_scoped")
    const file = ledgerPath()
    const scopeA = { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
    const scopeB = { input: 40, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }
    const scopeALater = { input: 150, output: 15, reasoning: 0, cache: { read: 0, write: 0 } }
    const beforeRestart = createSandboxUsageLedger({ path: file, workspaceId: "ws_real" })
    const first = sandbox(beforeRestart, plane.fetch)
    for (const event of [usageEvent("ses_scoped", "msg_scoped", "a", scopeA), usageEvent("ses_scoped", "msg_scoped", "b", scopeB)]) {
      first.onPresentationEvent(event)
    }
    await first.drain()
    beforeRestart.close()

    const ledger = openLedger(file)
    const usage = sandbox(ledger, plane.fetch)
    usage.onPresentationEvent(usageEvent("ses_scoped", "msg_scoped", "a", scopeALater))
    await usage.drain()

    expect((await ledger.current({ sessionId: "ses_scoped" }))[0]?.tokens)
      .toEqual({ input: 190, output: 19, reasoning: 0, cache: { read: 0, write: 0 } })
  })

  test("keeps only each message's latest revision once the plane has answered for it", async () => {
    const plane = await openPlane()
    await plane.session("ses_pruned")
    const file = ledgerPath()
    const ledger = openLedger(file)
    const usage = sandbox(ledger, plane.fetch)
    const growing = [1, 2, 3].map((step) => usageEvent("ses_pruned", "msg_assistant_1", "", {
      input: 100 * step, output: 10 * step, reasoning: 0, cache: { read: 0, write: 0 },
    }))

    await runTurn(plane, usage, {
      by: plane.owner,
      sessionId: "ses_pruned",
      turnId: "msg_user_1",
      events: [...growing, envelope(messageCompleted("ses_pruned", "msg_assistant_1"))],
    })

    const inspect = new Database(file, { readonly: true })
    cleanups.push(() => { inspect.close() })
    const rows = inspect.prepare("select revision, delivery from usage_revisions where message_id = 'msg_assistant_1'").all()
    const [filed] = await plane.ledger.current({ sessionId: "ses_pruned" })
    expect(rows).toEqual([{ revision: filed?.revision, delivery: "delivered" }])
  })

  test("answers every read and write of a turn's metering and delivery from an index, not a table scan", async () => {
    const plane = await openPlane()
    await plane.session("ses_planned")
    const file = ledgerPath()
    const spy = vi.spyOn(Database.prototype, "prepare")
    cleanups.push(() => spy.mockRestore())
    const ledger = openLedger(file)
    const usage = sandbox(ledger, plane.fetch, { ses_planned_child: "ses_planned" })
    for (const event of turnEvents("ses_planned", "msg_unleased", { completed: true })) usage.onPresentationEvent(event)
    await usage.drain()
    await runTurn(plane, usage, {
      by: plane.owner,
      sessionId: "ses_planned",
      turnId: "msg_user_1",
      events: [
        ...turnEvents("ses_planned", "msg_assistant_1", { completed: true }),
        ...turnEvents("ses_planned_child", "msg_child_1", { completed: true }),
        usageEvent("ses_planned", "msg_assistant_2", "a", TOKENS),
      ],
    })
    const statements = new Set(spy.mock.calls.flatMap(([source], index) => {
      const connection = spy.mock.contexts[index]
      return connection instanceof Database && connection.name === file ? [source] : []
    }))
    spy.mockRestore()

    const inspect = new Database(file, { readonly: true })
    cleanups.push(() => { inspect.close() })
    const planned = [...statements].filter((source) => /^\s*(select|insert|update|delete)/i.test(source))
    for (const read of [/turn_session_id = \?/, /turn_id is null/, /select max\(revision\)/]) {
      expect(planned.some((source) => read.test(source)), String(read)).toBe(true)
    }
    for (const source of planned) {
      const parameters = Array.from(source.matchAll(/\?/g), () => "x")
      const plan = inspect.prepare(`explain query plan ${source}`).all(...parameters) as Array<{ detail: string }>
      const scans = plan.map(({ detail }) => detail).filter((detail) => detail.startsWith("SCAN ") && !/ USING (COVERING )?INDEX /.test(detail))
      expect(scans, source).toEqual([])
    }
  })
})
