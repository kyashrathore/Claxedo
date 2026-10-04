import { describe, expect, test } from "bun:test"

import {
  AGENT_HARNESS_DEFINITIONS,
  harnessKey,
  isAcpConnectionId,
  normalizeAgentHarnessTransport,
  normalizeHarnessIdentity,
} from "./harnesses"

describe("agent harness process catalog", () => {
  test("keeps one unique catalog key per supported harness and access", () => {
    expect(new Set(AGENT_HARNESS_DEFINITIONS.map((row) => row.key)).size).toBe(AGENT_HARNESS_DEFINITIONS.length)
    expect(
      new Set(AGENT_HARNESS_DEFINITIONS.map((row) => `${row.id}:${row.access}`)).size,
    ).toBe(AGENT_HARNESS_DEFINITIONS.length)
    expect(new Set(AGENT_HARNESS_DEFINITIONS.map((row) => row.id))).toEqual(
      new Set(["claude", "codex", "cursor", "pi", "opencode"]),
    )
  })
})

describe("configured connection identity", () => {
  test("a validated descriptor identity uses structured connection access only", () => {
    expect(normalizeHarnessIdentity({ id: "gemini", access: "connection" })).toEqual({ id: "gemini", access: "connection" })
    expect(normalizeHarnessIdentity("connection:gemini")).toBeUndefined()
    expect(harnessKey({ id: "gemini", access: "connection" })).toBe("connection:gemini")
  })

  test("native ids keep their built-in keys while connections are qualified internally", () => {
    expect(harnessKey({ id: "claude", access: "connection" })).toBe("connection:claude")
    expect(harnessKey({ id: "codex", access: "native" })).toBe("codex")
    expect(normalizeHarnessIdentity("connection:claude")).toBeUndefined()
    expect(normalizeHarnessIdentity("codex-app-server")).toBeUndefined()
  })

  test("an unknown id never defaults to a native identity", () => {
    expect(normalizeHarnessIdentity("gemini")).toBeUndefined()
    expect(normalizeHarnessIdentity({ id: "gemini" })).toBeUndefined()
    expect(normalizeHarnessIdentity({ id: "gemini", access: "native" })).toBeUndefined()
  })

  test("custom ids shadowing built-in names stay connection-qualified", () => {
    expect(normalizeHarnessIdentity({ id: "claude", access: "connection" })).toEqual({ id: "claude", access: "connection" })
    expect(harnessKey({ id: "claude", access: "connection" })).toBe("connection:claude")
  })

  test("blank, malformed, or overlong slugs fail validation", () => {
    expect(isAcpConnectionId("")).toBe(false)
    expect(isAcpConnectionId("Gemini")).toBe(false)
    expect(isAcpConnectionId("1gemini")).toBe(false)
    expect(isAcpConnectionId("gem ini")).toBe(false)
    expect(isAcpConnectionId("connection:gemini")).toBe(false)
    expect(isAcpConnectionId("g".repeat(65))).toBe(false)
    expect(isAcpConnectionId("gemini-2")).toBe(true)
    expect(normalizeHarnessIdentity({ id: "Gem ini", access: "connection" })).toBeUndefined()
    expect(normalizeHarnessIdentity("connection:")).toBeUndefined()
  })
})

describe("connection transport identity", () => {
  test("accepts only exact v3 transport discriminants", () => {
    expect(normalizeAgentHarnessTransport("stdio")).toBe("stdio")
    expect(normalizeAgentHarnessTransport("streamable-http")).toBe("streamable-http")
    expect(normalizeAgentHarnessTransport("websocket")).toBe("websocket")
    expect(normalizeAgentHarnessTransport("http")).toBeUndefined()
  })
})
