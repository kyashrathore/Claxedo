import { describe, expect, test } from "bun:test"
import {
  assertSessionConfigPatchResponse,
  parseSessionConfigPatch,
} from "../helpers/contracts/session-config"

describe("session config contract", () => {
  test("normalizes the accepted request identity into the canonical harness shape", () => {
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

  test("preserves normalized harness connection metadata from the authoritative normalizer", () => {
    expect(
      parseSessionConfigPatch(
        {
          harness: {
            id: "claude",
            access: "acp",
            connection: {
              kind: "remote",
              transport: "http",
              url: "http://127.0.0.1:4096/acp",
              headers: { authorization: "Bearer test" },
            },
          },
        },
        "http://localhost/session/session-1/config",
      ),
    ).toEqual({
      harness: {
        id: "claude",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:4096/acp",
          headers: { authorization: "Bearer test" },
        },
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
