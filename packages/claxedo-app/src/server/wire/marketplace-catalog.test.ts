/// <reference types="bun" />
import { expect, test } from "bun:test"
import { marketplaceCatalogFromWire } from "./marketplace-catalog"

const activation = {
  explicit: null,
  projectOverride: null,
  userDefault: null,
  effective: { status: "ready", effective: false, winner: "none" },
} as const

function candidate(harnesses: Record<string, unknown>) {
  return {
    pluginInstanceId: "docs",
    source: null,
    sourceAvailable: true,
    updateAvailable: false,
    groups: [],
    skills: [],
    manifest: { name: "docs", version: "1.0.0" },
    componentDiagnostics: [],
    mcpServers: [],
    harnesses,
  }
}

function catalog(supportedHarnesses: readonly string[], harnesses: Record<string, unknown>) {
  return { revision: 3, supportedHarnesses, candidates: [candidate(harnesses)], errors: [] }
}

const HOSTED_TARGETS = ["opencode", "claude", "codex", "cursor", "pi", "acp"] as const
const everyTarget = Object.fromEntries(HOSTED_TARGETS.map((id) => [id, activation]))

test("plugin catalog from the wire: the hosted catalog's targets, Pi and custom ACP agents included, parse", () => {
  const parsed = marketplaceCatalogFromWire(catalog(HOSTED_TARGETS, everyTarget))
  expect(parsed?.supportedHarnesses).toEqual([...HOSTED_TARGETS])
  expect(parsed?.candidates[0]?.harnesses.pi).toEqual(activation)
  expect(parsed?.candidates[0]?.harnesses.acp).toEqual(activation)
})

test("plugin catalog from the wire: an unknown target or a candidate missing a target is a contract mismatch", () => {
  expect(marketplaceCatalogFromWire(catalog(["opencode", "gemini"], everyTarget))).toBeUndefined()
  const withoutPi = Object.fromEntries(HOSTED_TARGETS.filter((id) => id !== "pi").map((id) => [id, activation]))
  expect(marketplaceCatalogFromWire(catalog(["opencode"], withoutPi))).toBeUndefined()
})
