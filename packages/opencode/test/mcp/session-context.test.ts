import { describe, expect, test } from "bun:test"
import { withMcpSessionContext } from "../../src/mcp/session-context"

describe("MCP session context", () => {
  test("injects the current session into the argument named by tool metadata", () => {
    expect(withMcpSessionContext(
      { _meta: { "io.claxedo/session-argument": "session_id" } },
      { id_or_name: "claxedo://document/document-1" },
      "session-current",
    )).toEqual({ id_or_name: "claxedo://document/document-1", session_id: "session-current" })
  })

  test("preserves explicit arguments and ignores unrelated metadata", () => {
    const explicit = { session_id: "session-explicit" }
    expect(withMcpSessionContext(
      { _meta: { "io.claxedo/session-argument": "session_id" } },
      explicit,
      "session-current",
    )).toBe(explicit)

    const ordinary = { value: true }
    expect(withMcpSessionContext({ _meta: { other: "session_id" } }, ordinary, "session-current")).toBe(ordinary)
  })
})
