import { describe, expect, test } from "bun:test"
import { classifyFirstTurnError, firstTurnErrorData } from "./first-turn-error"

describe("first-turn error taxonomy", () => {
  test.each([
    ["401 Unauthorized: invalid API key", "credential"],
    ["OAuth token expired", "credential"],
    ["the claude credential selected for this workspace cannot be used: revoked", "credential"],
    ["Claude Code returned an error result: You've reached your Fable 5 limit. Switch to another model to continue.", "usage_limit"],
    ["You've reached your Codex rate limit. It will reset in about 5 hours.", "usage_limit"],
    ["You've reached your Codex usage limit.", "usage_limit"],
    ["rate_limit_reached", "usage_limit"],
    ["Claude assistant message failed: rate_limit", "usage_limit"],
    ["workspace_owner_usage_limit_reached", "usage_limit"],
    ["ACP harness process failed to start", "harness"],
    ["unsupported adapter capability", "harness"],
    ["harness_switch_not_supported", "harness"],
    ["Model claude-missing was not found", "model"],
    ["provider/model selection is required", "model"],
    ["workspace is not ready", "workspace"],
    ["ENOENT: repository directory does not exist", "workspace"],
    ["thread not found: 019f73fb-1234-4abc-8def-0123456789ab", "session"],
    ["session not found", "session"],
    ["no such thread", "session"],
  ] as const)("classifies %s as %s", (message, expected) => {
    expect(classifyFirstTurnError(message)).toBe(expected)
  })

  /**
   * A brokered turn reports the broker's HTTP status, and 401/403 there say
   * nothing about the operator's account: the broker answers 403 both for a
   * withdrawn credential and for a route the binding does not allow. The code
   * in the body is the only thing that tells them apart.
   */
  test.each([
    ['Failed to authenticate. API Error: 403 {"error":"binding_unavailable"}', "credential"],
    ['API Error: 401 {"error":"runtime_token_invalid"}', "credential"],
    ['API Error: 503 {"error":"credential_unavailable"}', "credential"],
    ['API Error: 403 {"error":"binding_not_permitted"}', "credential"],
    ['API Error: 403 {"error":"request_outside_policy"}', "harness"],
    ['API Error: 503 {"error":"broker_authority_unavailable"}', "harness"],
    ['API Error: 502 {"error":"upstream_unavailable"}', "model"],
    ['API Error: 502 {"error":"upstream_redirect_refused"}', "model"],
    // The mounts in front of the broker answer in the same vocabulary. A caller
    // that is not on loopback reached the broker from somewhere it should not
    // have; the operator's account is not what is wrong.
    ['API Error: 403 {"error":{"code":"loopback_required","message":"The credential broker answers loopback callers only"}}', "harness"],
  ] as const)("reads the broker's own verdict out of %s", (message, expected) => {
    expect(classifyFirstTurnError(message)).toBe(expected)
  })

  test("the code in the body outranks an earlier one in the prose around it", () => {
    // A harness that retried names the first failure in its own text; the
    // verdict belongs to the body of the response it actually gave up on.
    expect(classifyFirstTurnError(
      'upstream_unavailable while retrying; API Error: 403 '
      + '{"error":{"code":"binding_unavailable","message":"The binding names no account this runtime can spend"}}',
    )).toBe("credential")
  })

  test("the broker's verdict outranks the status the harness echoed beside it", () => {
    // Without the code this reads as `credential` on the bare "403" and marks
    // a working account broken for a route the harness should not have called.
    expect(classifyFirstTurnError('API Error: 403 {"error":"request_outside_policy"}')).not.toBe("credential")
    // And a rate-limited-looking message from the broker is still the broker's.
    expect(classifyFirstTurnError('rate_limit hit; API Error: 403 {"error":"request_outside_policy"}'))
      .toBe("harness")
  })

  test("classifies unrecognized failures as unknown", () => {
    expect(classifyFirstTurnError("connection closed unexpectedly")).toBe("unknown")
    expect(classifyFirstTurnError("Stream error")).toBe("unknown")
  })

  test("attaches the typed class without replacing the original message", () => {
    expect(firstTurnErrorData("401 Unauthorized")).toEqual({
      message: "401 Unauthorized",
      firstTurnErrorClass: "credential",
    })
  })
})
