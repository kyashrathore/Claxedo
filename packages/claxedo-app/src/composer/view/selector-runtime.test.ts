/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { nativeHarness, type HarnessSelection } from "@/lib/harness-selection"
import type { WorkspaceRuntime } from "@/server"
import { harnessMachineRuntime } from "./selector-runtime"

function observe(runtime: WorkspaceRuntime, harness: HarnessSelection | undefined) {
  return createRoot((dispose) => {
    const [current] = createSignal(runtime)
    const view = harnessMachineRuntime(current, () => harness)
    const seen = { kind: view.runtime().kind, asleep: view.asleep() }
    dispose()
    return seen
  })
}

test("selector runtime: Pi answers from its session host, so its picker never reads the machine as asleep, waking or failed", () => {
  const failed: WorkspaceRuntime = { kind: "wakeFailed", error: { class: "conflict", message: "no", retryable: false } }
  for (const runtime of [{ kind: "asleep" }, { kind: "waking" }, failed] satisfies readonly WorkspaceRuntime[]) {
    expect(observe(runtime, nativeHarness("pi")), runtime.kind).toEqual({ kind: "live", asleep: false })
  }
})

test("selector runtime: a sandbox harness or no harness sees the machine's own state", () => {
  expect(observe({ kind: "asleep" }, nativeHarness("claude"))).toEqual({ kind: "asleep", asleep: true })
  expect(observe({ kind: "waking" }, nativeHarness("codex"))).toEqual({ kind: "waking", asleep: true })
  expect(observe({ kind: "asleep" }, undefined)).toEqual({ kind: "asleep", asleep: true })
  expect(observe({ kind: "live" }, nativeHarness("claude"))).toEqual({ kind: "live", asleep: false })
})
