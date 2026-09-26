/// <reference types="bun" />
import { expect, test } from "bun:test"
import { connectionHarness, nativeHarness } from "@/lib/harness-selection"
import { createHarnessStore } from "./harness-store"
import type { HarnessWiring } from "./harness-wiring"
import { applyPushedHarnessHealth } from "./session-harness"

function wiringOver(store: ReturnType<typeof createHarnessStore>) {
  return { store } as unknown as HarnessWiring
}

function memoryStorage() {
  const items = new Map<string, string>()
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) }
}

test("pushed harness health: a lost process marks the session degraded, and its recovery marks it ready", () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("session:s1", { harness: nativeHarness("pi"), readiness: "ready" })
  applyPushedHarnessHealth(wiringOver(store), "session:s1", { harnessHealth: { status: "degraded", reason: "harness_process_lost" } })
  expect(store.read("session:s1").readiness).toBe("degraded")
  applyPushedHarnessHealth(wiringOver(store), "session:s1", { harnessHealth: { status: "ok" } })
  expect(store.read("session:s1").readiness).toBe("ready")
})

test("pushed harness health: a connection's state lands on the scope bound to that connection only", () => {
  const store = createHarnessStore(memoryStorage())
  store.applyPatch("session:s1", { harness: connectionHarness("gw"), readiness: "ready" })
  applyPushedHarnessHealth(wiringOver(store), "session:s1", { harnessHealth: { status: "ok" }, connectionState: { connectionId: "other", state: "disconnected" } })
  expect(store.read("session:s1").connectionState).toBeUndefined()
  applyPushedHarnessHealth(wiringOver(store), "session:s1", { harnessHealth: { status: "ok" }, connectionState: { connectionId: "gw", state: "disconnected" } })
  expect(store.read("session:s1").connectionState).toEqual({ connectionId: "gw", state: "disconnected" })
})

test("pushed harness health: a scope never opened, or one still connecting, is left alone", () => {
  const store = createHarnessStore(memoryStorage())
  applyPushedHarnessHealth(wiringOver(store), "session:unseen", { harnessHealth: { status: "degraded" } })
  expect(store.state("session:unseen")).toBeUndefined()
  store.applyPatch("session:s2", { harness: nativeHarness("codex"), readiness: "polling" })
  applyPushedHarnessHealth(wiringOver(store), "session:s2", { harnessHealth: { status: "degraded" } })
  expect(store.read("session:s2").readiness).toBe("polling")
})
