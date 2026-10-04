import { describe, expect, test } from "bun:test"
import { decodeHarnessConnectionsCatalog, type HarnessConnectionRef } from "./connections"

const row: HarnessConnectionRef = {
  connectionId: "pi", label: "Remote Pi", enabled: true, readiness: "ready",
  capabilities: { abort: true, reconnect: false, replay: true, permissions: true, questions: false, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false },
  modelSelection: { status: "optional" },
}

describe("public connection discovery contract", () => {
  test("distinguishes supported empty discovery from unsupported discovery", () => {
    expect(decodeHarnessConnectionsCatalog({ status: "supported", connections: [] })).toEqual({ status: "supported", connections: [] })
    expect(decodeHarnessConnectionsCatalog({ status: "unsupported", reason: "operator_local_configuration" })).toEqual({ status: "unsupported", reason: "operator_local_configuration" })
  })

  test("projects only browser-safe fields while preserving opaque identity", () => {
    expect(decodeHarnessConnectionsCatalog({ status: "supported", connections: [{ ...row, config: { token: "private" }, secretRefs: { token: "private-ref" } }] })).toEqual({ status: "supported", connections: [row] })
  })

  test.each([
    undefined, {}, { connections: [] }, { status: "supported" },
    { status: "unsupported", reason: "" }, { status: "unsupported", reason: "local", connections: [] },
    ...[{ readiness: "unknown" }, { connectionId: "" }, { capabilities: { abort: true } }, { modelSelection: { status: "required", models: [] } }, { modelSelection: { status: "unsupported", models: [] } }].map((invalid) => ({ status: "supported", connections: [row, { ...row, ...invalid }] })),
  ])("rejects an invalid envelope or row: %j", (value) => {
    expect(() => decodeHarnessConnectionsCatalog(value)).toThrow()
  })
})
