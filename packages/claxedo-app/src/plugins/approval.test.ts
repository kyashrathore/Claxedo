import { expect, test } from "bun:test"
import type { PluginManifest } from "@claxedo/plugin-api"
import { approvalCheck, approvalFor, approvalLetsRun } from "./approval"

const manifest: PluginManifest = { id: "fixture", name: "Fixture", version: "0.1.0", app: "./app.tsx", requires: [], server: { routes: [], operations: [] } }
const approved = approvalFor({ manifest, hash: "a".repeat(16), builtAt: "2026-10-17T20:00:00.000Z" }, new Date("2026-10-17T20:01:00.000Z"))

test("the build the user approved runs", () => {
  const check = approvalCheck(approved, { manifest, hash: "a".repeat(16), builtAt: "2026-10-17T20:00:00.000Z" })
  expect(check).toEqual({ kind: "approved" })
  expect(approvalLetsRun(check)).toBe(true)
})

test("new code with the same access waits for approval of that build", () => {
  const check = approvalCheck(approved, { manifest, hash: "b".repeat(16), builtAt: "2026-10-17T21:00:00.000Z" })
  expect(check).toEqual({ kind: "codeChanged", builtAt: "2026-10-17T21:00:00.000Z" })
  expect(approvalLetsRun(check)).toBe(false)
})

test("changed access and a plugin never approved both wait", () => {
  const wider = { ...manifest, server: { routes: ["/api/claxedo/tasks"], operations: [] } }
  expect(approvalLetsRun(approvalCheck(approved, { manifest: wider, hash: "a".repeat(16), builtAt: "2026-10-17T20:00:00.000Z" }))).toBe(false)
  expect(approvalLetsRun(approvalCheck(undefined, { manifest, hash: "a".repeat(16), builtAt: "2026-10-17T20:00:00.000Z" }))).toBe(false)
})
