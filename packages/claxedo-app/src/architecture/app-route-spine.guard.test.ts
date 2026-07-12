import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { APP_ROOT_ROUTE_FILE, appRouteSpineViolations } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

// Re-homes the app/entry/app.tsx route-spine / route-ordering / negative-invariant
// assertions retired with `pages/override-batch-contract.test.ts`. The router
// routes are JSX (there is no exported route table to assert against), so per
// CONTRIBUTING this genuine invariant lives as a named scanner rule here,
// centrally tracked — not a Bun.file+toContain grep in a pages/*.test.ts.

describe("app/entry/app.tsx route spine guard", () => {
  test("app/entry/app.tsx composes the full route spine, in order, with no retired markers", () => {
    const source = readFileSync(path.join(appRoot, "src", APP_ROOT_ROUTE_FILE), "utf8")
    expect(appRouteSpineViolations(source)).toEqual([])
  })

  const healthy = [
    "<ServerProvider>",
    "<GlobalSyncProvider>",
    '<Route path="/permissions" />',
    '<Route path="/config" />',
    '<Route path="/s/:sessionId" />',
    '<Route path="/w/:workspaceId" />',
    '<Route path="/marketplace" />',
    '<Route path="/:dir" />',
  ].join("\n")

  test("a well-formed spine (all markers, marketplace before /:dir, no ServerKey) yields no findings", () => {
    expect(appRouteSpineViolations(healthy)).toEqual([])
  })

  test("flags a missing required route-spine marker", () => {
    const missingConfig = healthy.replace('<Route path="/config" />', "")
    expect(appRouteSpineViolations(missingConfig)).toEqual([
      { file: APP_ROOT_ROUTE_FILE, line: 1, match: 'missing route-spine marker: path="/config"' },
    ])
  })

  test("flags /marketplace registered after the catch-all /:dir route", () => {
    const reordered = [
      "<ServerProvider>",
      "<GlobalSyncProvider>",
      '<Route path="/permissions" />',
      '<Route path="/config" />',
      '<Route path="/s/:sessionId" />',
      '<Route path="/w/:workspaceId" />',
      '<Route path="/:dir" />',
      '<Route path="/marketplace" />',
    ].join("\n")
    expect(appRouteSpineViolations(reordered)).toEqual([
      { file: APP_ROOT_ROUTE_FILE, line: 7, match: 'route path="/marketplace" must precede catch-all path="/:dir"' },
    ])
  })

  test("flags a retired forbidden marker (ServerKey) reappearing", () => {
    const withForbidden = `${healthy}\nconst k = ServerKey`
    expect(appRouteSpineViolations(withForbidden)).toEqual([
      { file: APP_ROOT_ROUTE_FILE, line: 9, match: "forbidden marker: ServerKey" },
    ])
  })
})
