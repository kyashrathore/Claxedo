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

function sandbox(ledger: SandboxUsageLedger, fetch: Fetch) {
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
  return usage
}

function envelope(payload: CompatEnvelope["payload"]): CompatEnvelope {
  return { directory: "/workspace", payload }
}

function turnEvents(sessionId: string, messageId: string, input: { completed: boolean }) {
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
        tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } },
      },
    })),
  ]
  return input.completed ? [...events, envelope(messageCompleted(sessionId, messageId))] : events
}

async function turnAccess(plane: UsageReportPlane, sessionId: string) {
  return {
    actor: { actorId: plane.owner.user.tokenIdentifier, actorKind: "human" as const },
    authority: { managed: true as const, workspaceId: "ws_real", orgId: plane.orgId, role: "editor" as const },
    credential: `Bearer ${await plane.relayToken(plane.owner)}`,
    operation: "prompt" as const,
    sessionId,
  }
}

/** One turn through the runtime's own policy: acquire, the harness's events, release. */
async function runTurn(
  plane: UsageReportPlane,
  usage: ReturnType<typeof sandbox>,
  input: { sessionId: string; turnId: string; events: CompatEnvelope[] },
) {
  const access = await turnAccess(plane, input.sessionId)
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

  test("a turn's report carries only what was metered before its release, never the next turn's usage", async () => {
    const plane = await openPlane()
    await plane.session("ses_handoff")
    const ledger = openLedger(ledgerPath())
    let usage: ReturnType<typeof sandbox> | undefined
    const handoff: Fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : ""
      if (body.includes("\"turn_release\"")) {
        for (const event of turnEvents("ses_handoff", "msg_next_turn", { completed: false })) usage?.onCompatEvent(event)
      }
      return await plane.fetch(url, init)
    }
    usage = sandbox(ledger, handoff)

    await runTurn(plane, usage, {
      sessionId: "ses_handoff",
      turnId: "msg_user_1",
      events: turnEvents("ses_handoff", "msg_assistant_1", { completed: true }),
    })

    expect((await plane.ledger.current({ sessionId: "ses_handoff" })).map((fact) => fact.messageId)).toEqual(["msg_assistant_1"])
    expect(ledger.pending("ses_handoff").map((fact) => fact.messageId)).toEqual(["msg_next_turn"])
  })

  test("keeps what the plane did not answer for across a restart and delivers it with the session's next turn", async () => {
    const plane = await openPlane()
    await plane.session("ses_retried")
    const file = ledgerPath()
    let refuseReports = true
    const flaky: Fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? init.body : ""
      if (refuseReports && body.includes("\"usage_report\"")) return Response.json({ error: { code: "unavailable" } }, { status: 503 })
      return await plane.fetch(url, init)
    }
    const beforeRestart = createSandboxUsageLedger({ path: file, workspaceId: "ws_real" })
    await runTurn(plane, sandbox(beforeRestart, flaky), {
      sessionId: "ses_retried",
      turnId: "msg_user_1",
      events: turnEvents("ses_retried", "msg_assistant_1", { completed: false }),
    })
    expect(beforeRestart.pending("ses_retried").map((fact) => fact.settlement)).toEqual(["provisional"])
    expect(await plane.ledger.current({ sessionId: "ses_retried" })).toEqual([])
    beforeRestart.close()

    refuseReports = false
    const afterRestart = openLedger(file)
    const usage = sandbox(afterRestart, flaky)
    await usage.idle()
    await runTurn(plane, usage, { sessionId: "ses_retried", turnId: "msg_user_2", events: [] })

    expect(afterRestart.pending("ses_retried")).toEqual([])
    expect(await plane.ledger.current({ sessionId: "ses_retried" })).toEqual([expect.objectContaining({
      messageId: "msg_assistant_1",
      settlement: "partial",
      status: "process_lost",
      location: "cloud-workspace",
      tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 90 } },
    })])
  })
})
