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
    expect(normalizeHarnessIdentity({ id: "acme", access: "connection" })).toEqual({ id: "acme", access: "connection" })
    expect(normalizeHarnessIdentity("connection:acme")).toBeUndefined()
    expect(harnessKey({ id: "acme", access: "connection" })).toBe("connection:acme")
  })

  test("native ids keep their built-in keys while connections are qualified internally", () => {
    expect(harnessKey({ id: "claude", access: "connection" })).toBe("connection:claude")
    expect(harnessKey({ id: "codex", access: "native" })).toBe("codex")
    expect(normalizeHarnessIdentity("connection:claude")).toBeUndefined()
    expect(normalizeHarnessIdentity("codex-app-server")).toBeUndefined()
  })

  test("an unknown id never defaults to a native identity", () => {
    expect(normalizeHarnessIdentity("acme")).toBeUndefined()
    expect(normalizeHarnessIdentity({ id: "acme" })).toBeUndefined()
    expect(normalizeHarnessIdentity({ id: "acme", access: "native" })).toBeUndefined()
  })

  test("custom ids shadowing built-in names stay connection-qualified", () => {
    expect(normalizeHarnessIdentity({ id: "claude", access: "connection" })).toEqual({ id: "claude", access: "connection" })
    expect(harnessKey({ id: "claude", access: "connection" })).toBe("connection:claude")
  })

  test("blank, malformed, or overlong slugs fail validation", () => {
    expect(isAcpConnectionId("")).toBe(false)
    expect(isAcpConnectionId("Acme")).toBe(false)
    expect(isAcpConnectionId("1acme")).toBe(false)
    expect(isAcpConnectionId("acm e")).toBe(false)
    expect(isAcpConnectionId("connection:acme")).toBe(false)
    expect(isAcpConnectionId("g".repeat(65))).toBe(false)
    expect(isAcpConnectionId("acme-2")).toBe(true)
    expect(normalizeHarnessIdentity({ id: "Acm e", access: "connection" })).toBeUndefined()
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
