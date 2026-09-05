import { describe, expect, test } from "bun:test"
import { parseExistingSessionConfig, sameExistingSessionConfig } from "./submit-session-config"

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
    expect(parseExistingSessionConfig({ harness: { id: "opencode", access: "native" } })).toBeUndefined()
    expect(parseExistingSessionConfig({ harness: { id: "claude", access: "acp" } })).toBeUndefined()
  })
})
