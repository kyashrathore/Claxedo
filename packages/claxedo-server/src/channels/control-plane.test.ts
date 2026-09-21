import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { cancelChannelSessionTurn, createControlPlaneChannels, mountControlPlaneChannels } from "./control-plane"
import { serializeRecoveryOutcome, type RecoveryOperation, type RecoveryOperationState, type RecoveryOutcome, type RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import type { ControlPlaneServices } from "../authority/services"

/**
 * The pairing admin bearer gate. Loopback callers are admitted unconditionally;
 * a non-loopback caller must present `Bearer ${CLAXEDO_CHANNEL_ADMIN_TOKEN}` —
 * the comparison is what this file exercises. In-process Requests carry no
 * transport peer, so the loopback classifier falls back to the Host header:
 * `https://admin.example.test/...` takes the remote branch, `http://127.0.0.1`
 * the loopback one.
 */

const ADMIN_TOKEN = "0123456789abcdef0123456789abcdef"

function pairingAdminApp(env: Record<string, string>) {
  const channels = {
    access: {
      listPending: vi.fn(async () => []),
      approve: vi.fn(async () => ({ ok: true as const, channel: "telegram", externalUserId: "u_1" })),
    },
    ingress: new Hono(),
  } as unknown as ReturnType<typeof createControlPlaneChannels>
  const app = new Hono()
  mountControlPlaneChannels(app, {
    services: {} as ControlPlaneServices,
    runtime: {} as never,
    env,
    channels,
    requireLoopbackForFake: false,
  })
  return { app, channels }
}

describe("pairing admin bearer gate", () => {
  test("a loopback caller is admitted without a token", async () => {
    const { app, channels } = pairingAdminApp({})
    const res = await app.request("http://127.0.0.1/api/channels/pairing")
    expect(res.status).toBe(200)
    expect(channels.access.listPending).toHaveBeenCalled()
  })

  test("a remote caller with the correct bearer token is admitted", async () => {
    const { app } = pairingAdminApp({ CLAXEDO_CHANNEL_ADMIN_TOKEN: ADMIN_TOKEN })
    const res = await app.request("https://admin.example.test/api/channels/pairing", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(200)
  })

  test("a remote caller with an invalid or unequal-length token is refused", async () => {
    const { app, channels } = pairingAdminApp({ CLAXEDO_CHANNEL_ADMIN_TOKEN: ADMIN_TOKEN })
    for (const authorization of [
      `Bearer ${"0".repeat(ADMIN_TOKEN.length)}`,
      `Bearer ${ADMIN_TOKEN.slice(0, -1)}`,
      `Bearer ${ADMIN_TOKEN}x`,
      `Token ${ADMIN_TOKEN}`,
      "",
    ]) {
      const res = await app.request("https://admin.example.test/api/channels/pairing", {
        headers: authorization ? { authorization } : {},
      })
      expect(res.status, authorization || "(no header)").toBe(401)
    }
    expect(channels.access.listPending).not.toHaveBeenCalled()
  })

  test("a remote caller is refused when no admin token is configured", async () => {
    const { app } = pairingAdminApp({})
    const res = await app.request("https://admin.example.test/api/channels/pairing", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(res.status).toBe(401)
  })

  test("the same gate guards approve", async () => {
    const { app, channels } = pairingAdminApp({ CLAXEDO_CHANNEL_ADMIN_TOKEN: ADMIN_TOKEN })
    const denied = await app.request("https://admin.example.test/api/channels/pairing/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN.slice(1)}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC123" }),
    })
    expect(denied.status).toBe(401)
    expect(channels.access.approve).not.toHaveBeenCalled()

    const allowed = await app.request("https://admin.example.test/api/channels/pairing/approve", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ code: "ABC123" }),
    })
    expect(allowed.status).toBe(200)
    expect(channels.access.approve).toHaveBeenCalledWith("ABC123", "admin:route")
  })
})

const TARGET: RecoveryTurnTarget = {
  scope: "turn",
  workspaceId: "ws_1",
  sessionId: "ses_1",
  turnId: "msg_1",
  ownerGeneration: "lease_1",
}

/**
 * What a local Stop can establish. `cancel_turn` only closes as `succeeded`
 * under `cleanup: "verified_clear"`, which no adapter proves, so a healthy Stop
 * settles as `needs_action` with cleanup unknown.
 */
const FACTS = {
  execution: { value: "terminal" as const, source: "codex", observedAt: 1, generation: "lease_1" },
  cleanup: { value: "unknown" as const, source: "codex", observedAt: 1, generation: "lease_1" },
  persistence: { value: "committed" as const, source: "store", observedAt: 1, generation: "lease_1" },
}

function operation(state: RecoveryOperationState, message?: string): RecoveryOperation {
  return {
    operationId: "op_1",
    requestId: "req_1",
    target: TARGET,
    action: "cancel_turn",
    scopeRevision: "lease_1",
    attempt: 1,
    state,
    phase: "graceful_cancel",
    phaseDeadlineAt: 2,
    facts: FACTS,
    ...(message
      ? {
          initiatingError: {
            code: "cancellation_timeout" as const,
            origin: "codex",
            target: TARGET,
            stage: "graceful_cancel" as const,
            executionMayContinue: true,
            message,
            at: 1,
          },
        }
      : {}),
    cleanupErrors: [],
    nextActions: [],
    receipt: "durable",
    createdAt: 1,
    updatedAt: 1,
  }
}

function runtimeDouble(input: {
  inspection?: Response
  answer?: RecoveryOutcome | Response
}) {
  const sent: Array<{ resource: string; method: string; body?: string }> = []
  const request = async (resource: string, init: RequestInit) => {
    sent.push({ resource, method: init.method ?? "GET", ...(typeof init.body === "string" ? { body: init.body } : {}) })
    if ((init.method ?? "GET") === "GET") return input.inspection ?? Response.json({ sessionId: "ses_1", target: TARGET })
    if (input.answer instanceof Response) return input.answer
    return new Response(serializeRecoveryOutcome(input.answer ?? { kind: "operation", operation: operation("needs_action") }))
  }
  return { sent, request }
}

describe("a channel Stop", () => {
  test("names the turn the owner reports and hands the whole outcome back", async () => {
    const runtime = runtimeDouble({})

    const result = await cancelChannelSessionTurn("ses_1", runtime.request)

    expect(result).toEqual({ kind: "outcome", outcome: { kind: "operation", operation: operation("needs_action") } })
    expect(runtime.sent.map((call) => `${call.method} ${call.resource}`)).toEqual(["GET recovery", "POST recovery"])
    const submitted = JSON.parse(runtime.sent[1].body!) as Record<string, unknown>
    expect(submitted).toMatchObject({ action: "cancel_turn", target: TARGET, scopeRevision: "lease_1", attempt: 1 })
    expect(String(submitted.requestId)).toMatch(/^channel-stop:/)
  })

  test("a session running no turn is its own answer, and nothing is submitted for it", async () => {
    const runtime = runtimeDouble({ inspection: Response.json({ sessionId: "ses_1" }) })

    await expect(cancelChannelSessionTurn("ses_1", runtime.request)).resolves.toEqual({ kind: "no_active_turn" })
    expect(runtime.sent).toHaveLength(1)
  })

  test("an owner that refuses the inspection is the owner speaking, not an idle session", async () => {
    const refusal = { kind: "unavailable" as const, message: "the machine is offline" }
    const runtime = runtimeDouble({
      inspection: new Response(serializeRecoveryOutcome({ kind: "refused", refusal }), { status: 503 }),
    })

    await expect(cancelChannelSessionTurn("ses_1", runtime.request)).resolves.toEqual({
      kind: "outcome",
      outcome: { kind: "refused", refusal },
    })
    expect(runtime.sent).toHaveLength(1)
  })

  test("a refusal of the cancellation reaches the caller whole", async () => {
    const refusal = { kind: "generation_conflict" as const, message: "the turn was replaced", current: TARGET }
    const runtime = runtimeDouble({ answer: { kind: "refused", refusal } })

    await expect(cancelChannelSessionTurn("ses_1", runtime.request)).resolves.toEqual({
      kind: "outcome",
      outcome: { kind: "refused", refusal },
    })
  })

  test("every operation state is reported as the operation it was, none of them collapsed", async () => {
    for (const state of ["succeeded", "failed", "needs_action", "running", "accepted"] as const) {
      const answered = operation(state, "the provider never acknowledged")
      const runtime = runtimeDouble({ answer: { kind: "operation", operation: answered } })
      await expect(cancelChannelSessionTurn("ses_1", runtime.request), state).resolves.toEqual({
        kind: "outcome",
        outcome: { kind: "operation", operation: answered },
      })
    }
  })

  test("an unreachable owner and an unreadable answer are both reported, not guessed at", async () => {
    const unreachable = runtimeDouble({ inspection: new Response("", { status: 503 }) })
    await expect(cancelChannelSessionTurn("ses_1", unreachable.request)).resolves.toEqual({
      kind: "unreachable",
      message: "Session ses_1 has no reachable recovery owner",
    })

    const garbled = runtimeDouble({ answer: new Response("<html>gateway</html>", { status: 502 }) })
    await expect(cancelChannelSessionTurn("ses_1", garbled.request)).resolves.toMatchObject({ kind: "unreachable" })
  })
})
