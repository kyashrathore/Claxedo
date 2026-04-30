import { describe, expect, it } from "bun:test"
import matrix from "./acp-coverage-matrix.json"
import schema from "@agentclientprotocol/sdk/schema/schema.json"

function variants(name: "SessionUpdate" | "ToolCallContent" | "ContentBlock") {
  const def = (schema as { $defs: Record<string, { oneOf?: Array<{ properties?: Record<string, { const?: string }> }> }> }).$defs[name]
  return (def.oneOf ?? []).flatMap((item) => {
    const props = item.properties ?? {}
    const value = props.sessionUpdate?.const ?? props.type?.const
    return value ? [value] : []
  }).sort()
}

function methods() {
  return [...new Set(Object.values(
    (schema as { $defs: Record<string, Record<string, unknown>> }).$defs,
  ).flatMap((item) => typeof item["x-method"] === "string" ? [item["x-method"]] : []))].sort()
}

function matrixKeys(key: "methods" | "session_update_variants" | "tool_call_content_variants" | "content_block_variants") {
  return Object.keys(matrix[key]).sort()
}

describe("ACP coverage matrix", () => {
  it("lists every SDK method", () => {
    expect(matrixKeys("methods")).toEqual(methods())
  })

  it("lists every SessionUpdate variant", () => {
    expect(matrixKeys("session_update_variants")).toEqual(variants("SessionUpdate"))
  })

  it("lists every ToolCallContent variant", () => {
    expect(matrixKeys("tool_call_content_variants")).toEqual(variants("ToolCallContent"))
  })

  it("lists every ContentBlock variant", () => {
    expect(matrixKeys("content_block_variants")).toEqual(variants("ContentBlock"))
  })

  it("requires explicit reasons for unsupported or partial coverage", () => {
    const sections = [
      matrix.methods,
      matrix.session_update_variants,
      matrix.tool_call_content_variants,
      matrix.content_block_variants,
    ]
    for (const section of sections) {
      for (const [key, value] of Object.entries(section)) {
        const row = value as { handled: boolean | string; reason?: string; known_gap?: string }
        if (row.handled === true) continue
        expect(`${key}:${row.reason ?? row.known_gap ?? ""}`).not.toBe(`${key}:`)
      }
    }
  })
})
