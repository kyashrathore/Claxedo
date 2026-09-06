/**
 * Metering — the server-side emission contract.
 *
 * The token test drives the REAL chain a completed turn travels inside this
 * package: `buildAssistantMessage` (the production compat-message builder) →
 * the central runtime's `publishGlobal` ingress → the captured event and the
 * ledger write. Nothing here re-derives the numbers, so the assertion is that
 * the emitted fields EQUAL the fake provider's usage object rather than that an
 * emit function was reached.
 */

import { describe, expect, test } from "vitest"
import { buildAssistantMessage, messageUpdated } from "@claxedo/agent-sdk-runtime/compat-events"
import {
  LLM_TURN_COMPLETED,
  SANDBOX_LEASE_CLOSED,
  SANDBOX_LEASE_OPENED,
  USER_ACTIVATED,
  emitLlmTurnCompleted,
  emitSandboxLeaseClosed,
  emitSandboxLeaseOpened,
  leaseClosedProperties,
  llmTurnRecord,
  tokenProperties,
  type UsageLedger,
} from "./metering"
import type { ProductIdentity } from "./product"

/**
 * The fake provider's usage object as the agent runtime hands it over —
 * `compat-events.ts` populates exactly this block on a completed assistant
 * message, and it is the boundary this package consumes. (The per-harness
 * mappers that produce it, e.g. the ACP `messageUsage`, live behind that
 * package's own export surface.)
 *
 * Every expectation below reads from THIS object, so a flattening that
 * silently swapped two fields would have to change it to stay green.
 */
const FAKE_PROVIDER_USAGE = {
  input: 1_337,
  output: 271,
  reasoning: 42,
  cache: { read: 900, write: 17 },
}

const IDENTITY: ProductIdentity = {
  org_id: "org_1",
  user_id: "user_sub_1",
  surface: "session",
  deployment_mode: "cloud",
}

type Captured = { distinctId: string; event: string; properties: Record<string, unknown> }

function captureSink() {
  const events: Captured[] = []
  return {
    events,
    sink: {
      capture: (distinctId: string, event: string, properties: Record<string, unknown> = {}) => {
        events.push({ distinctId, event, properties })
      },
    },
    only: (event: string) => events.filter((item) => item.event === event),
  }
}

// ---------------------------------------------------------------------------

describe("llm_turn_completed carries the provider's usage object verbatim", () => {
  test("the emitted token fields equal the provider's usage object, not a re-derivation", async () => {
    const message = buildAssistantMessage({
      id: "msg_verbatim",
      sessionID: "s_verbatim",
      parentID: "msg_user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      directory: "/w",
      created: 1_000,
      completed: 3_500,
      finish: "stop",
    })
    const record = llmTurnRecord({
      message: messageUpdated({ ...message, tokens: FAKE_PROVIDER_USAGE }).properties.info,
      harness: "pi",
    })
    expect(record).toMatchObject({
      message_id: "msg_verbatim",
      session_id: "s_verbatim",
      harness: "pi",
      provider_id: "anthropic",
      model_id: "claude-sonnet-5",
      turn_status: "ok",
      latency_ms: 2_500,
      input_tokens: FAKE_PROVIDER_USAGE.input,
      output_tokens: FAKE_PROVIDER_USAGE.output,
      reasoning_tokens: FAKE_PROVIDER_USAGE.reasoning,
      cache_read_tokens: FAKE_PROVIDER_USAGE.cache.read,
      cache_write_tokens: FAKE_PROVIDER_USAGE.cache.write,
    })

    const captured = captureSink()
    await emitLlmTurnCompleted({ identity: IDENTITY, sink: captured.sink, ledger: undefined, record: record! })
    expect(captured.only(LLM_TURN_COMPLETED)[0].properties).toMatchObject({
      input_tokens: FAKE_PROVIDER_USAGE.input,
      output_tokens: FAKE_PROVIDER_USAGE.output,
      cache_read_tokens: FAKE_PROVIDER_USAGE.cache.read,
      cache_write_tokens: FAKE_PROVIDER_USAGE.cache.write,
    })
  })

  test("an in-flight assistant message and a user message are not turns", () => {
    expect(llmTurnRecord({ message: { role: "user", sessionID: "s", time: { completed: 1 } }, harness: "pi" }))
      .toBeUndefined()
    expect(llmTurnRecord({ message: { role: "assistant", sessionID: "s", time: { created: 1 } }, harness: "pi" }))
      .toBeUndefined()
  })

  test("absent or negative counts normalize to zero rather than poisoning a sum", () => {
    expect(tokenProperties(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
    expect(tokenProperties({ input: -5, output: Number.NaN, cache: { read: 3 } })).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 3,
    })
  })
})

describe("user_activated fires exactly once", () => {
  function activationHarness() {
    const captured = captureSink()
    let activations = 0
    const ledger: UsageLedger = {
      // Mirrors the authority check-and-set: the first ok turn activates, and no
      // later turn does.
      recordLlmTurn: async (input) => {
        if (input.turn_status !== "ok") return { activated: false }
        activations += 1
        return { activated: activations === 1 }
      },
    }
    return { captured, ledger }
  }

  test("an error turn then an ok turn fires once; a third ok turn does not re-fire", async () => {
    const { captured, ledger } = activationHarness()
    const record = {
      message_id: "msg_1",
      session_id: "s_1",
      harness: "pi",
      provider_id: "anthropic",
      model_id: "claude-sonnet-5",
      ...tokenProperties({ input: 10, output: 2 }),
      latency_ms: 5,
    }

    await emitLlmTurnCompleted({
      identity: IDENTITY,
      sink: captured.sink,
      ledger,
      record: { ...record, turn_status: "error" },
    })
    expect(captured.only(USER_ACTIVATED)).toHaveLength(0)

    await emitLlmTurnCompleted({
      identity: IDENTITY,
      sink: captured.sink,
      ledger,
      record: { ...record, turn_status: "ok" },
    })
    expect(captured.only(USER_ACTIVATED)).toHaveLength(1)
    expect(captured.only(USER_ACTIVATED)[0].properties).toMatchObject({
      org_id: "org_1",
      user_id: "user_sub_1",
      session_id: "s_1",
    })

    await emitLlmTurnCompleted({
      identity: IDENTITY,
      sink: captured.sink,
      ledger,
      record: { ...record, turn_status: "ok" },
    })
    expect(captured.only(USER_ACTIVATED)).toHaveLength(1)
    // All three turns are still measured — activation is a separate question.
    expect(captured.only(LLM_TURN_COMPLETED)).toHaveLength(3)
  })

  test("a failed ledger write degrades visibly instead of silently", async () => {
    const captured = captureSink()
    const result = await emitLlmTurnCompleted({
      identity: IDENTITY,
      sink: captured.sink,
      ledger: { recordLlmTurn: async () => { throw new Error("authority unreachable") } },
      record: {
        message_id: "msg_1",
        session_id: "s_1",
        harness: "pi",
        provider_id: "anthropic",
        model_id: "m",
        ...tokenProperties({ input: 1 }),
        turn_status: "ok",
        latency_ms: 1,
      },
    })
    expect(result).toMatchObject({ activated: false, ledger_write: "failed" })
    // The analytics view still gets the turn, flagged so the gap is visible in
    // the data rather than only in a log line.
    expect(captured.only(LLM_TURN_COMPLETED)[0].properties.ledger_write).toBe("failed")
    expect(captured.only(USER_ACTIVATED)).toHaveLength(0)
  })
})

describe("sandbox lease events", () => {
  test("an opened lease carries the tenant, the driver, and the start", () => {
    const captured = captureSink()
    emitSandboxLeaseOpened({
      identity: IDENTITY,
      sink: captured.sink,
      lease: { workspace_id: "ws_1", driver: "daytona", started_at: 1_000 },
    })
    expect(captured.only(SANDBOX_LEASE_OPENED)[0].properties).toMatchObject({
      workspace_id: "ws_1",
      driver: "daytona",
      started_at: 1_000,
      org_id: "org_1",
    })
  })

  test("a close with a known start reports the subtraction; one without omits it", () => {
    expect(leaseClosedProperties({
      workspace_id: "ws_1",
      driver: "daytona",
      started_at: 1_000,
      ended_at: 61_000,
      reason: "explicit_release",
    })).toMatchObject({ active_ms: 60_000, reason: "explicit_release" })

    // A zero here would average into the per-user answer as if the sandbox ran
    // for no time at all, so the field is absent instead.
    expect(leaseClosedProperties({
      workspace_id: "ws_1",
      driver: "daytona",
      ended_at: 61_000,
      reason: "gc",
    })).not.toHaveProperty("active_ms")
  })

  test("the ledger's own subtraction wins over a locally reconstructed one", () => {
    expect(leaseClosedProperties({
      workspace_id: "ws_1",
      driver: "daytona",
      started_at: 1_000,
      ended_at: 61_000,
      active_ms: 59_998,
      reason: "idle_timeout",
    }).active_ms).toBe(59_998)
  })

  test("an operator-token close lands on the ops plane and names the missing identity", () => {
    const captured = captureSink()
    emitSandboxLeaseClosed({
      identity: undefined,
      sink: captured.sink,
      lease: { workspace_id: "ws_1", driver: "daytona", ended_at: 5, reason: "gc" },
      systemReason: "internal_admin_token_has_no_user",
    })
    const event = captured.only(SANDBOX_LEASE_CLOSED)[0]
    expect(event.distinctId).toBe("system")
    expect(event.properties.system_reason).toBe("internal_admin_token_has_no_user")
    expect(event.properties.org_id).toBeUndefined()
  })

  test("a throwing sink never propagates into the operation it observes", () => {
    const exploding = { capture: () => { throw new Error("sink down") } }
    expect(() => emitSandboxLeaseOpened({
      identity: IDENTITY,
      sink: exploding,
      lease: { workspace_id: "ws_1", driver: "daytona", started_at: 1 },
    })).not.toThrow()
    expect(() => emitSandboxLeaseClosed({
      identity: undefined,
      sink: exploding,
      lease: { workspace_id: "ws_1", driver: "daytona", ended_at: 1, reason: "gc" },
    })).not.toThrow()
  })
})
