/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { IntegrationConnectOutcome } from "@/server"
import { connectError, connectionReadinessKey, integrationPurpose } from "./connections"
import en from "./locales/en"

const t = (key: keyof typeof en, vars: Record<string, string> = {}) => en[key].replace(/{{(\w+)}}/g, (_, name: string) => vars[name] ?? "")

type Failed = Extract<IntegrationConnectOutcome, { kind: "failed" }>

const FAILURES: readonly Failed[] = [
  { kind: "failed", reason: "unoffered", status: 404 },
  { kind: "failed", reason: "rejected", status: 403, code: "connections_loopback_required" },
  { kind: "failed", reason: "rejected", status: 401 },
  { kind: "failed", reason: "failed", status: 500 },
  { kind: "failed", reason: "failed", status: 502, code: "provider_unavailable" },
  { kind: "failed", reason: "unreachable" },
  { kind: "failed", reason: "failed" },
]

test("connectError: no failure shows a raw HTTP status or a server code", () => {
  for (const failure of FAILURES) {
    const copy = connectError(failure)
    expect(copy).not.toMatch(/\b[1-5]\d\d\b/)
    expect(copy).not.toContain("status")
    if (failure.code) expect(copy).not.toContain(failure.code)
  }
})

test("connectError: a verify failure names why the credentials were refused", () => {
  expect(connectError({ kind: "failed", reason: "rejected", status: 400, code: "connection_verify_failed", verifyReason: "unauthorized" })).toBe(
    "The provided credentials were rejected. Check the values and try again.",
  )
})

test("integrationPurpose says in one sentence what an integration is used for, never its capability ids", () => {
  expect(integrationPurpose(t, ["code-host", "work-source"], "en")).toBe("Lets agents clone your repositories into cloud workspaces and read the issues you give them.")
  expect(integrationPurpose(t, ["docs"], "en")).toBe("Lets agents read your documents.")
  expect(integrationPurpose(t, ["unknown-capability"], "en")).toBeUndefined()
})

test("an agent connection's readiness is said in words, never as its wire value", () => {
  expect(t(connectionReadinessKey("configured"))).toBe("Set up, not checked yet")
  expect(t(connectionReadinessKey("ready"))).toBe("Ready")
})
