import { describe, expect, test } from "bun:test"
import { USAGE_WINDOW_NAMES } from "@claxedo/agent-runtime-contract"
import { createAgentEventRuntime } from "../../../translate/runtime"
import { claudeSdkAdapter } from "./adapter"

describe("claudeSdkAdapter rate limits", () => {
  const emitted = (info: Record<string, unknown>) => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    return agent.ingest({
      source: "claude.sdk",
      method: "claude/rate_limit_event",
      payload: { type: "rate_limit_event", uuid: "rate-1", session_id: "sdk-session-1", rate_limit_info: info },
    }).events.map(({ harness: _harness, threadId: _threadId, raw: _raw, ...event }) => event)
  }

  test("names the five-hour, weekly and opus windows the way the usage read does", () => {
    expect(emitted({ status: "allowed", rateLimitType: "five_hour", utilization: 0.424, resetsAt: 1_757_700_000 })).toEqual([{
      type: "rate-limit",
      status: "ok",
      usedPercent: 42,
      resetsAt: 1_757_700_000_000,
      limitId: "five_hour",
      limitName: "session",
    }])
    expect(emitted({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 })[0])
      .toMatchObject({ status: "ok", limitId: "seven_day", limitName: "weekly" })
    expect(emitted({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.05 })[0])
      .toMatchObject({ limitId: "seven_day_opus", limitName: "weekly_opus" })
    for (const [slot, name] of Object.entries(USAGE_WINDOW_NAMES.claude ?? {})) {
      expect(emitted({ status: "allowed", rateLimitType: slot, utilization: 1 })[0]).toMatchObject({ limitName: name })
    }
  })

  test("passes a window the vendor added since through under its own name", () => {
    expect(emitted({ status: "allowed", rateLimitType: "seven_day_sonnet", utilization: 0.12 })[0])
      .toMatchObject({ limitId: "seven_day_sonnet", limitName: "seven_day_sonnet" })
  })

  test("a window spelled like a prototype member names itself, not an inherited value", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(emitted({ status: "allowed", rateLimitType: key, utilization: 1 })[0])
        .toMatchObject({ limitId: key, limitName: key })
    }
  })

  test("a rate_limit refusal is a temporary rate limit unless the last window report rejected a plan window", () => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    const window = (status: string) => agent.ingest({
      source: "claude.sdk",
      method: "claude/rate_limit_event",
      payload: { type: "rate_limit_event", uuid: `rate-${status}`, session_id: "sdk-session-1", rate_limit_info: { status, rateLimitType: "five_hour" } },
    })
    const refusal = () => {
      agent.ingest({
        source: "claude.sdk.message",
        payload: {
          type: "assistant", error: "rate_limit",
          message: { content: [{ type: "text", text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." }] },
        },
      })
      return agent.ingest({ source: "claude.sdk.message", payload: { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error" } })
        .events.find((event) => event.type === "error")
    }

    expect(refusal()).toMatchObject({ type: "error", errorClass: "rate_limit" })
    window("rejected")
    expect(refusal()).toMatchObject({ type: "error", errorClass: "usage_limit" })
    window("allowed")
    expect(refusal()).toMatchObject({ type: "error", errorClass: "rate_limit" })
  })

  test("the owner's recorded 429, with no window report before it in its session, is a temporary rate limit", () => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        message: {
          id: "9ee31f29-0ea3-48fa-91c1-91a9e43c812b",
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          stop_sequence: "",
          type: "message",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [{ type: "text", text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." }],
        },
        parent_tool_use_id: null,
        session_id: "b66f22f2-d1b5-442e-8f63-bc12b84276d9",
        uuid: "c47b02b7-8985-4da0-859c-fdf3dbe6736f",
        error: "rate_limit",
        is_api_error_message: true,
      },
    })
    const events = agent.ingest({ source: "claude.sdk.message", payload: { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error" } }).events
    expect(events.find((event) => event.type === "error")).toMatchObject({ errorClass: "rate_limit" })
  })

  test("a refusal inside a recorded rejected weekly window names the window and when it resets", () => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    agent.ingest({
      source: "claude.sdk",
      method: "claude/rate_limit_event",
      payload: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1790391600,
          rateLimitType: "seven_day",
          overageStatus: "rejected",
          overageDisabledReason: "org_level_disabled",
          isUsingOverage: false,
          unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1790129400 }, seven_day: { utilization: 1, resetsAt: 1790391600 } },
        },
        uuid: "b33b8089-cf07-417f-8f1c-cb639d495f83",
        session_id: "8f4a7cac-7236-426d-befc-31ea7d872d95",
      },
    })
    agent.ingest({
      source: "claude.sdk.message",
      payload: {
        type: "assistant",
        message: {
          id: "62753f45-5dbd-4494-952e-99c0e5408885",
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          type: "message",
          content: [{ type: "text", text: "You've hit your weekly limit · resets Sep 26 at 8:30am (Asia/Calcutta)" }],
        },
        parent_tool_use_id: null,
        session_id: "8f4a7cac-7236-426d-befc-31ea7d872d95",
        uuid: "27cdc408-be34-43d1-9ffe-d435254e8d41",
        error: "rate_limit",
        is_api_error_message: true,
      },
    })
    const refusal = agent.ingest({ source: "claude.sdk.message", payload: { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error",
      result: "You've hit your weekly limit · resets Sep 26 at 8:30am (Asia/Calcutta)", session_id: "8f4a7cac-7236-426d-befc-31ea7d872d95" } })
      .events.find((event) => event.type === "error")

    expect(refusal).toMatchObject({
      type: "error",
      error: [
        `You've reached your Claude weekly limit. It will reset at ${new Date(1_790_391_600_000).toLocaleString()}.`,
        "You've hit your weekly limit · resets Sep 26 at 8:30am (Asia/Calcutta)",
      ].join("\n"),
      errorClass: "usage_limit",
    })
  })

  test("an assistant failure that is no limit carries no class of its own", () => {
    const agent = createAgentEventRuntime({
      harness: "claude-sdk",
      threadId: "thread-1",
      adapter: claudeSdkAdapter(),
      clock: () => 0,
      createId: (prefix = "id") => `${prefix}-1`,
    })
    agent.ingest({ source: "claude.sdk.message", payload: { type: "assistant", error: "invalid_request", message: { content: [] } } })
    const [, error] = agent.ingest({ source: "claude.sdk.message", payload: { type: "result", subtype: "success", is_error: true, terminal_reason: "api_error", result: "API Error: 400" } }).events
    expect(error).toMatchObject({ type: "error" })
    expect(error).not.toHaveProperty("errorClass")
  })

  test("only a rejection is a limit", () => {
    expect(emitted({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1_757_700_000 })).toEqual([{
      type: "rate-limit",
      status: "limited",
      usedPercent: 100,
      resetsAt: 1_757_700_000_000,
      limitId: "five_hour",
      limitName: "session",
    }])
  })

  test("omits the percentage and the window name the vendor left out", () => {
    const [event] = emitted({ status: "allowed" })
    expect(event).toEqual({ type: "rate-limit", status: "ok", resetsAt: null })
    expect(Object.keys(event ?? {}).sort()).toEqual(["resetsAt", "status", "type"])
  })

  test("reads utilization as a fraction of the window and clamps it to 0..100 percent", () => {
    expect(emitted({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1789974000, isUsingOverage: false, surpassedThreshold: 0.75 })[0]).toMatchObject({ usedPercent: 81 })
    expect(emitted({ status: "allowed", utilization: 1.376 })[0]).toMatchObject({ usedPercent: 100 })
    expect(emitted({ status: "allowed", utilization: -0.04 })[0]).toMatchObject({ usedPercent: 0 })
  })

  test("normalises the reset to epoch milliseconds, whichever unit the vendor sent", () => {
    expect(emitted({ status: "allowed", resetsAt: 1_757_700_000 })[0]).toMatchObject({ resetsAt: 1_757_700_000_000 })
    expect(emitted({ status: "allowed", resetsAt: 1_757_700_000_000 })[0]).toMatchObject({ resetsAt: 1_757_700_000_000 })
    expect(emitted({ status: "allowed", resetsAt: "soon" })[0]).toMatchObject({ resetsAt: null })
  })
})
