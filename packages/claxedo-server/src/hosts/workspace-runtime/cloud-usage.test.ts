import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { buildAssistantMessage, messageCompleted, messageUpdated, sessionUsage } from "@claxedo/agent-sdk-runtime/compat-events"
import { remoteWorkspaceSessionAccessPolicy } from "@claxedo/workspace-runtime"
import { cloudWorkspaceUsage, createSandboxUsageLedger, type SandboxUsageLedger } from "./cloud-usage"
import { usageReportPlane, USAGE_REPORT_URL, type UsageReportPlane } from "../../test-support/usage-report-plane"

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
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
function sandbox(ledger: SandboxUsageLedger, fetch: Fetch, parents: Record<string, string> = {}) {
  const usage = cloudWorkspaceUsage({
    workspaceId: "ws_real",
    ledger,
    authorityUrl: USAGE_REPORT_URL,
    policy: remoteWorkspaceSessionAccessPolicy({ url: USAGE_REPORT_URL, fetch }),
    fetch,
  })
  usage.bindSessionConfig(() => ({
    harness: { id: "codex", access: "native" },
    model: { providerID: "openai", modelID: "gpt-5.4" },
  }))
  usage.bindSessionParents((sessionId) => parents[sessionId])
  return usage
}

function envelope(payload: CompatEnvelope["payload"]): CompatEnvelope {
  return { directory: "/workspace", payload }
}

const TOKENS = { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } }

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
        observedAt: Date.parse("2026-09-20T10:00:00Z"),
        tokens: input.tokens ?? TOKENS,
      },
    })),
  ]
  return input.completed ? [...events, envelope(messageCompleted(sessionId, messageId))] : events
}

type Account = UsageReportPlane["owner"]

async function turnAccess(plane: UsageReportPlane, sessionId: string, by: Account) {
  return {
    actor: { actorId: by.user.tokenIdentifier, actorKind: "human" as const },
    authority: { managed: true as const, workspaceId: "ws_real", orgId: plane.orgId, role: "editor" as const },
    credential: `Bearer ${await plane.relayToken(by)}`,
    operation: "prompt" as const,
    sessionId,
  }
}

/** One turn through the runtime's own policy: acquire, the harness's events, release. */
async function runTurn(
  plane: UsageReportPlane,
  usage: ReturnType<typeof sandbox>,
  input: { by: Account; sessionId: string; turnId: string; events: CompatEnvelope[] },
) {
  const access = await turnAccess(plane, input.sessionId, input.by)
  const acquired = await usage.sessionAccessPolicy.acquireTurn!({ ...access, turnId: input.turnId })
  if (!acquired.allowed) throw new Error(`turn was refused: ${acquired.code}`)
  for (const event of input.events) usage.onCompatEvent(event)
  const released = await usage.sessionAccessPolicy.releaseTurn!({
    ...access,
    turnId: input.turnId,
    leaseId: acquired.leaseId,
    fencingToken: acquired.fencingToken,
  })
  await usage.idle()
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
  const filed = await plane.ledger.pendingOutbox({ all: true, owner: { org_id: plane.orgId, user_id: userId } })
  return filed.map((fact) => fact.messageId)
}

describe("cloud workspace usage metering", () => {
  test("meters a cloud-workspace revision from the runtime's events under the session's committed harness", async () => {
    const plane = await openPlane()
    const ledger = openLedger(ledgerPath())
    const usage = sandbox(ledger, plane.fetch)

    for (const event of turnEvents("ses_metered", "msg_assistant_1", { completed: true })) usage.onCompatEvent(event)
    await usage.idle()

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
    const filed = await plane.ledger.pendingOutbox({ all: true, owner: { org_id: plane.orgId, user_id: "owner" } })
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

  test("keeps usage no turn was holding across a restart, and delivers it with the next turn its session or an ancestor ends", async () => {
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
    ]) idle.onCompatEvent(event)
    await idle.idle()
    beforeRestart.close()

    const ledger = openLedger(file)
    const usage = sandbox(ledger, plane.fetch, parents)
    await usage.idle()
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
    await usage.idle()
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
