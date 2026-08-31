import { describe, expect, test } from "bun:test"
import {
  parseExistingSessionConfig,
  preferAuthoritativeExistingSessionConfig,
  sameExistingSessionConfig,
} from "./submit-session-config"

describe("preferAuthoritativeExistingSessionConfig", () => {
  test("structurally equal connection selections do not trigger a config write", () => {
    const left = parseExistingSessionConfig({
      harness: { id: "external-opencode", access: "connection" },
      model: { providerID: "external-opencode", modelID: "default" },
    })!
    const right = parseExistingSessionConfig({
      harness: { id: "external-opencode", access: "connection" },
      model: { providerID: "external-opencode", modelID: "default" },
    })!

    expect(left.harnessType).not.toBe(right.harnessType)
    expect(sameExistingSessionConfig(left, right)).toBe(true)
  })

  test("a model-less GET default does not replace structured session info", () => {
    const fromInfo = parseExistingSessionConfig({
      harness: { id: "claude", access: "acp" },
      agent: "build",
      model: { providerID: "claude-acp", modelID: "opus" },
      variant: "high",
    })
    const fetched = parseExistingSessionConfig({
      harness: { id: "opencode", access: "native" },
    })

    expect(preferAuthoritativeExistingSessionConfig(fetched, fromInfo)).toEqual(fromInfo)
  })

  test("a live config with a model remains the source of truth", () => {
    const fromInfo = parseExistingSessionConfig({
      harness: { id: "opencode", access: "native" },
      model: { providerID: "old-provider", modelID: "old-model" },
    })
    const fetched = parseExistingSessionConfig({
      harness: { id: "opencode", access: "native" },
      agent: "review",
      model: { providerID: "new-provider", modelID: "new-model" },
    })

    expect(preferAuthoritativeExistingSessionConfig(fetched, fromInfo)).toEqual(fetched)
  })
})
