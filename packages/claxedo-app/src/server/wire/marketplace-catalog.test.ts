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

const everyTarget = { opencode: activation, claude: activation, codex: activation, cursor: activation, acp: activation }

test("plugin catalog from the wire: custom ACP agents are a plugin target", () => {
  const parsed = marketplaceCatalogFromWire(catalog(["opencode", "claude", "codex", "cursor", "acp"], everyTarget))
  expect(parsed?.supportedHarnesses).toEqual(["opencode", "claude", "codex", "cursor", "acp"])
  expect(parsed?.candidates[0]?.harnesses.acp).toEqual(activation)
})

test("plugin catalog from the wire: an unknown target or a candidate missing a target is a contract mismatch", () => {
  expect(marketplaceCatalogFromWire(catalog(["opencode", "pi"], everyTarget))).toBeUndefined()
  const withoutAcp = { opencode: activation, claude: activation, codex: activation, cursor: activation }
  expect(marketplaceCatalogFromWire(catalog(["opencode"], withoutAcp))).toBeUndefined()
})
