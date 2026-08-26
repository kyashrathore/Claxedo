import { describe, expect, test } from "bun:test"
import path from "node:path"
import { unguardedHistoryUrlWrites, walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

// The packaged desktop renderer is a file:// document routed by MemoryRouter.
// Three call sites wrote the route straight onto the document with
// `history.replaceState` / `pushState`, which left the window at
// `file:///w/<dir>/<session>`; reloading then asked Chromium to load that path
// as a FILE and failed with net::ERR_FAILED, stranding the user on a blank
// chrome-error:// page that only relaunching the app recovers. URL writes are
// meaningful only on an http(s) document, so they must be gated on
// `urlRoutingEnabled()`.
describe("history URL write guard", () => {
  test("no prod source writes history state without the urlRoutingEnabled guard", () => {
    expect(unguardedHistoryUrlWrites(walkProdSources(appRoot))).toEqual([])
  })

  test("flags a history write in a file that never consults the guard", () => {
    const offender = [
      "function replaceSessionUrl(id: string) {",
      '  window.history.replaceState(window.history.state, "", `/s/${id}`)',
      "}",
    ].join("\n")

    expect(unguardedHistoryUrlWrites([{ path: "features/session/offender.ts", text: offender }])).toEqual([
      { file: "features/session/offender.ts", line: 2, match: "history.replaceState(" },
    ])
  })

  test("flags pushState too, not just replaceState", () => {
    const offender = 'window.history.pushState(null, "", href)'

    expect(unguardedHistoryUrlWrites([{ path: "app/entry/offender.ts", text: offender }])).toEqual([
      { file: "app/entry/offender.ts", line: 1, match: "history.pushState(" },
    ])
  })

  test("accepts a history write in a file that consults the guard", () => {
    const guarded = [
      'import { urlRoutingEnabled } from "@/lib/runtime-mode"',
      "function replaceSessionUrl(id: string) {",
      "  if (!urlRoutingEnabled()) return",
      '  window.history.replaceState(window.history.state, "", `/s/${id}`)',
      "}",
    ].join("\n")

    expect(unguardedHistoryUrlWrites([{ path: "features/session/guarded.ts", text: guarded }])).toEqual([])
  })
})
