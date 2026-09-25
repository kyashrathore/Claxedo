import { describe, expect, test } from "vitest"
import { initialLivePluginState, servedBundle, transitionLivePlugin, type LivePluginState } from "./machine"

const manifest = { id: "notes", name: "Notes", version: "0.1.0", app: "./src/app.tsx", requires: [], server: { routes: [], operations: [] } }
const first = { hash: "a".repeat(16), manifest, builtAt: "2026-09-25T10:00:00.000Z" }
const second = { hash: "b".repeat(16), manifest: { ...manifest, version: "0.2.0" }, builtAt: "2026-09-25T10:05:00.000Z" }

describe("live plugin build machine", () => {
  test("starts building with nothing served, or ready on the last good build", () => {
    expect(initialLivePluginState(undefined)).toEqual({ kind: "building" })
    expect(initialLivePluginState(first)).toEqual({ kind: "ready", bundle: first })
  })

  test("a success serves the new bundle and a later failure keeps it", () => {
    let state: LivePluginState = initialLivePluginState(undefined)
    state = transitionLivePlugin(state, { type: "buildSucceeded", bundle: first })
    expect(servedBundle(state)).toEqual(first)
    state = transitionLivePlugin(state, { type: "buildStarted" })
    expect(state).toEqual({ kind: "building", last: first })
    state = transitionLivePlugin(state, { type: "buildFailed", error: "app.tsx: Unexpected end of file" })
    expect(state).toEqual({ kind: "failed", error: "app.tsx: Unexpected end of file", last: first })
    expect(servedBundle(state)).toEqual(first)
    state = transitionLivePlugin(state, { type: "buildStarted" })
    state = transitionLivePlugin(state, { type: "buildSucceeded", bundle: second })
    expect(state).toEqual({ kind: "ready", bundle: second })
  })

  test("a failure before any success serves nothing", () => {
    const state = transitionLivePlugin(initialLivePluginState(undefined), { type: "buildFailed", error: "no entry" })
    expect(state).toEqual({ kind: "failed", error: "no entry" })
    expect(servedBundle(state)).toBeUndefined()
  })
})
