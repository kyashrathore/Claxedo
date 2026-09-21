import { describe, expect, test } from "bun:test"
import { loadExistingSubmitConfig, parseExistingSessionConfig, sameExistingSessionConfig } from "./submit-session-config"

describe("existing session configuration", () => {
  test("structurally equal connection selections do not trigger a config write", () => {
    const config = { harness: { id: "external-opencode", access: "connection" }, model: { providerID: "backend", modelID: "default" } }
    const left = parseExistingSessionConfig(config)!
    const right = parseExistingSessionConfig(config)!
    expect(left.harnessType).not.toBe(right.harnessType)
    expect(sameExistingSessionConfig(left, right)).toBe(true)
  })

  test("native and connection bindings remain distinct even with the same ID", () => {
    const model = { providerID: "backend", modelID: "opaque/model[]" }
    const native = parseExistingSessionConfig({ harness: { id: "pi", access: "native" }, model })!
    const connection = parseExistingSessionConfig({ harness: { id: "pi", access: "connection" }, model })!
    expect(native.harnessType).toEqual({ kind: "native", harnessId: "pi" })
    expect(connection.harnessType).toEqual({ kind: "connection", connectionId: "pi" })
    expect(connection.model).toEqual(model)
    expect(sameExistingSessionConfig(native, connection)).toBe(false)
  })

  test("missing or invalid binding does not synthesize a harness", () => {
    expect(parseExistingSessionConfig({})).toBeUndefined()
    expect(parseExistingSessionConfig({ harness: { id: "legacy-engine", access: "native" } })).toBeUndefined()
    expect(parseExistingSessionConfig({ harness: { id: "claude", access: "acp" } })).toBeUndefined()
  })

  test("an unreadable existing binding stops submission and reports the original failure", async () => {
    const failure = new Error("Session unavailable")
    const errors: unknown[] = []
    expect(await loadExistingSubmitConfig(async () => { throw failure }, (error) => errors.push(error))).toBeUndefined()
    expect(errors).toEqual([failure])
    expect(await loadExistingSubmitConfig(
      async () => ({ harness: { id: "pi", access: "native" } }),
      (error) => errors.push(error),
    )).toBeUndefined()
    expect(errors[1]).toEqual(new Error("The session configuration is not available yet. Try again after it loads."))
  })
})

test("authoritative existing connection config may omit its agent-owned model", async () => {
  const errors: unknown[] = []
  expect(await loadExistingSubmitConfig(async () => ({ harness: { kind: "connection", connectionId: "agent" }, agent: "build" }), (error) => errors.push(error))).toEqual({ harnessType: { kind: "connection", connectionId: "agent" }, agent: "build" })
  expect(errors).toEqual([])
})
