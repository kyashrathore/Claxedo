/**
 * W5 metering — the server-side emission contract.
 *
 * The token test drives the REAL chain a completed turn travels inside this
 * package: `buildAssistantMessage` (the production compat-message builder) →
 * the central runtime's `publishGlobal` ingress → the captured event and the
 * ledger write. Nothing here re-derives the numbers, so the assertion is that
 * the emitted fields EQUAL the fake provider's usage object rather than that an
 * emit function was reached.
 */

import { describe, expect, test, vi } from "vitest"
import { buildAssistantMessage, messageUpdated } from "@claxedo/agent-sdk-runtime/compat-events"
import type { ControlPlaneServices } from "../control-plane/services"
import { localOnlyAuthAdapter } from "../control-plane/auth"
import { createCentralSessionRuntime } from "../central-session-runtime"
import { createConnectionTurnCredentials } from "../connections-host/turn-credentials"
import {
  LLM_TURN_COMPLETED,
  SANDBOX_LEASE_CLOSED,
  SANDBOX_LEASE_OPENED,
  SESSION_STARTED,
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

function services(telemetry: { capture: (id: string, event: string, props?: Record<string, unknown>) => void }): ControlPlaneServices {
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      sync_session_messages: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
      read_session_max_event_ordinal: vi.fn(() => 0),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
    },
    auth: localOnlyAuthAdapter(),
    credentials: {} as never,
    extensionPolicy: {},
    relay: {},
    sandbox: {},
    telemetry,
    localExecution: { enabled: true },
  } as unknown as ControlPlaneServices
}

/** A completed assistant message exactly as the harness would produce one. */
function completedTurn(input: {
  sessionId: string
  usage?: typeof FAKE_PROVIDER_USAGE
  error?: boolean
  created?: number
  completed?: number
}) {
  const info = buildAssistantMessage({
    id: `msg_${input.sessionId}`,
    sessionID: input.sessionId,
    parentID: "msg_user",
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
    directory: "/w",
    created: input.created ?? 1_000,
    completed: input.completed ?? 3_500,
    ...(input.error ? { error: { name: "UnknownError", data: { message: "boom" } } } : { finish: "stop" }),
  })
  return {
    scope: { directory: "/w", sessionId: input.sessionId },
    payload: messageUpdated({ ...info, tokens: input.usage ?? FAKE_PROVIDER_USAGE }),
  }
}

// ---------------------------------------------------------------------------

describe("llm_turn_completed carries the provider's usage object verbatim", () => {
  test("the emitted token fields equal the fake provider's usage, field for field", async () => {
    const captured = captureSink()
    const turnCredentials = createConnectionTurnCredentials()
    const recorded: Array<Record<string, unknown>> = []
    const ledger: UsageLedger = {
      recordLlmTurn: async (input) => {
        recorded.push(input)
        return { activated: false }
      },
    }
    const runtime = createCentralSessionRuntime(services(captured.sink), {
      turnCredentials,
      usageLedger: ledger,
      productDeploymentMode: "cloud",
    })

    const credential = turnCredentials.mint({ sessionId: "s_1", subject: "user_sub_1", orgId: "org_1" })
    turnCredentials.run(credential, () => publish(runtime, completedTurn({ sessionId: "s_1" })))
    await vi.waitFor(() => expect(recorded).toHaveLength(1))

    const event = captured.only(LLM_TURN_COMPLETED)[0]
    expect(event).toBeDefined()
    expect(event!.properties).toMatchObject({
      input_tokens: FAKE_PROVIDER_USAGE.input,
      output_tokens: FAKE_PROVIDER_USAGE.output,
      reasoning_tokens: FAKE_PROVIDER_USAGE.reasoning,
      cache_read_tokens: FAKE_PROVIDER_USAGE.cache.read,
      cache_write_tokens: FAKE_PROVIDER_USAGE.cache.write,
      session_id: "s_1",
      harness: "pi",
      provider_id: "anthropic",
      model_id: "claude-sonnet-5",
      turn_status: "ok",
      latency_ms: 2_500,
    })

    // Product plane: the turn is attributed to the caller that authorized it.
    expect(event!.distinctId).toBe("user_sub_1")
    expect(event!.properties).toMatchObject({
      org_id: "org_1",
      user_id: "user_sub_1",
      surface: "session",
      deployment_mode: "cloud",
      $groups: { org: "org_1" },
    })

    // Dual-write (D1): the authoritative row carries the same numbers.
    expect(recorded[0]).toMatchObject({
      org_id: "org_1",
      user_id: "user_sub_1",
      input_tokens: FAKE_PROVIDER_USAGE.input,
      output_tokens: FAKE_PROVIDER_USAGE.output,
      reasoning_tokens: FAKE_PROVIDER_USAGE.reasoning,
      cache_read_tokens: FAKE_PROVIDER_USAGE.cache.read,
      cache_write_tokens: FAKE_PROVIDER_USAGE.cache.write,
    })
  })

  test("hosted WorkGraph turns derive attribution from the deterministic Session identity", async () => {
    vi.stubEnv("CLAXEDO_WORKGRAPH_STREAM_ID", "wrong-cross-tenant-stream")
    const captured = captureSink()
    const turnCredentials = createConnectionTurnCredentials()
    const recorded: Array<Record<string, unknown>> = []
    const resolveWorkGraphAttribution = vi.fn(async () => ({
      stream_id: "stream_hosted",
      run_id: "run_hosted",
      work_item_id: "item_hosted",
    }))
    const runtime = createCentralSessionRuntime(services(captured.sink), {
      turnCredentials,
      usageLedger: {
        resolveWorkGraphAttribution,
        recordLlmTurn: async (input) => {
          recorded.push(input)
          return { activated: false }
        },
      },
      productDeploymentMode: "cloud",
    })
    const sessionId = "ses_wgrun_run_hosted"
    const credential = turnCredentials.mint({ sessionId, subject: "user_sub_1", orgId: "org_1" })

    turnCredentials.run(credential, () => publish(runtime, completedTurn({ sessionId })))
    await vi.waitFor(() => expect(recorded).toHaveLength(1))

    expect(resolveWorkGraphAttribution).toHaveBeenCalledWith({
      org_id: "org_1",
      user_id: "user_sub_1",
      session_id: sessionId,
    })
    expect(recorded[0]).toMatchObject({
      session_id: sessionId,
      stream_id: "stream_hosted",
      run_id: "run_hosted",
      work_item_id: "item_hosted",
    })
    expect(recorded[0]?.stream_id).not.toBe("wrong-cross-tenant-stream")
    vi.unstubAllEnvs()
  })

  test("a turn with no verified tenant is still measured, on the ops plane", async () => {
    const captured = captureSink()
    const turnCredentials = createConnectionTurnCredentials()
    const runtime = createCentralSessionRuntime(services(captured.sink), { turnCredentials })

    // A personal-account sign-in: a subject, no org claim.
    const credential = turnCredentials.mint({ sessionId: "s_2", subject: "user_sub_1" })
    turnCredentials.run(credential, () => publish(runtime, completedTurn({ sessionId: "s_2" })))
    await vi.waitFor(() => expect(captured.only(LLM_TURN_COMPLETED)).toHaveLength(1))

    const event = captured.only(LLM_TURN_COMPLETED)[0]!
    expect(event.distinctId).toBe("system")
    expect(event.properties.system_reason).toBe("no_signed_tenant")
    // No fabricated tenant: a placeholder org would corrupt every per-org
    // aggregate downstream, which is the entire deliverable.
    expect(event.properties.org_id).toBeUndefined()
    expect(event.properties.input_tokens).toBe(FAKE_PROVIDER_USAGE.input)
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
      // Mirrors the Convex check-and-set: the first ok turn activates, and no
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
    expect(captured.only(USER_ACTIVATED)[0]!.properties).toMatchObject({
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
      ledger: { recordLlmTurn: async () => { throw new Error("convex unreachable") } },
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
    expect(captured.only(LLM_TURN_COMPLETED)[0]!.properties.ledger_write).toBe("failed")
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
    expect(captured.only(SANDBOX_LEASE_OPENED)[0]!.properties).toMatchObject({
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
    const event = captured.only(SANDBOX_LEASE_CLOSED)[0]!
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

describe("session_started is server-emitted", () => {
  test("creating a central session emits it with the turn's tenant", async () => {
    const captured = captureSink()
    const turnCredentials = createConnectionTurnCredentials()
    const runtime = createCentralSessionRuntime(services(captured.sink), {
      turnCredentials,
      productDeploymentMode: "cloud",
    })

    const credential = turnCredentials.mint({ sessionId: "seed", subject: "user_sub_1", orgId: "org_1" })
    await turnCredentials.run(credential, () => runtime.createHybridSession({ title: "T" }))

    const event = captured.only(SESSION_STARTED)[0]
    expect(event).toBeDefined()
    expect(event!.distinctId).toBe("user_sub_1")
    expect(event!.properties).toMatchObject({ harness: "pi", host: "central", org_id: "org_1" })
  })
})

/**
 * The compat-event ingress the message route calls once a turn's assistant
 * message is final (`session-core.ts` publishes `messageUpdated(assistant)`
 * there). Driving the real ingress is what makes this an integration test
 * rather than a unit test of the builders.
 */
function publish(
  runtime: ReturnType<typeof createCentralSessionRuntime>,
  event: ReturnType<typeof completedTurn>,
) {
  runtime.publishGlobal(event as never)
}
