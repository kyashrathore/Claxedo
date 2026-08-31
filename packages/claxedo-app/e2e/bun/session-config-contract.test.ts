import { describe, expect, test } from "bun:test"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
} from "../helpers/contracts/session-config"

describe("session config contract", () => {
  test("preserves the canonical native harness identity", () => {
    expect(
      parseSessionConfigPatch(
        { harness: { type: "claude-sdk" }, agent: "build" },
        "http://localhost/session/session-1/config",
      ),
    ).toEqual({
      harness: { id: "claude", access: "native" },
      agent: "build",
    })
  })

  test("preserves a configured connection identity", () => {
    expect(
      parseSessionConfigPatch(
        {
          harness: {
            id: "team-agent",
            access: "connection",
          },
        },
        "http://localhost/session/session-1/config",
      ),
    ).toEqual({
      harness: {
        id: "team-agent",
        access: "connection",
      },
    })
  })

  test("accepts the canonical SessionConfig response", () => {
    expect(() =>
      assertSessionConfigPatchResponse(
        {
          harness: { id: "claude", access: "acp" },
          model: { providerID: "acp:claude", modelID: "opus" },
          variant: "high",
          agent: "build",
        },
        "http://localhost/session/session-1/config",
      )
    ).not.toThrow()
  })

  test("rejects the retired harness response alias", () => {
    expect(() =>
      assertSessionConfigPatchResponse(
        { harness: { type: "acp:claude" } },
        "http://localhost/session/session-1/config",
      )
    ).toThrow("response.harness.id must be a string")
  })
})
