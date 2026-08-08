import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createHostedApp, createSignedControlPlaneApp } from "./hosted-app"

/**
 * The split between boot validation and route assembly.
 *
 * `createHostedApp` validates a CLOUD posture — hosted deployment mode, signed
 * issuer, hosted authority — and then builds routes.
 * `createSignedControlPlaneApp` builds the same routes and validates nothing,
 * because Unit 7's self-hosted composition validates a DIFFERENT posture
 * (SQLite authority, embedded auth) over the same routes.
 *
 * The thing worth holding is that the validation stayed on exactly one side. A
 * check that migrated down into the shared core would have to be weakened to
 * suit both callers, and a hosted boot gate that passes for a self-hosted
 * configuration has stopped covering what it was written for. In the other
 * direction, a self-hosted app inheriting the cloud check simply would not
 * boot.
 */

const source = readFileSync(path.join(import.meta.dirname, "hosted-app.ts"), "utf8")

function bodyOf(name: string) {
  const start = source.indexOf(`export function ${name}(`)
  expect(start, `${name} must exist`).toBeGreaterThan(-1)
  // Up to the next top-level `export function`, or the end.
  const next = source.indexOf("\nexport function ", start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("the hosted/shared split", () => {
  test("both functions exist and are separately exported", () => {
    expect(typeof createHostedApp).toBe("function")
    expect(typeof createSignedControlPlaneApp).toBe("function")
    expect(createHostedApp).not.toBe(createSignedControlPlaneApp)
  })

  test("only the hosted wrapper asserts the cloud boot posture", () => {
    // Directional, both ways. Present in the wrapper, absent from the core.
    expect(bodyOf("createHostedApp")).toContain("assertHostedAppBootConfig(plane)")
    expect(bodyOf("createSignedControlPlaneApp")).not.toContain("assertHostedAppBootConfig")
  })

  test("the hosted wrapper asserts BEFORE building anything", () => {
    // A wrapper that built the app first and validated after would run every
    // composition side effect — including the process-wide CLI registry
    // install — for a configuration it was about to reject.
    const body = bodyOf("createHostedApp")

    expect(body.indexOf("assertHostedAppBootConfig")).toBeLessThan(body.indexOf("createSignedControlPlaneApp(plane"))
  })

  test("the shared core does no deployment-mode checking of its own", () => {
    // The whole reason it can be shared. Any posture decision here would have
    // to be true for both cloud and self-hosted, which means it would be
    // weaker than either deployment needs.
    const body = bodyOf("createSignedControlPlaneApp")

    for (const forbidden of ["assertHostedAppBootConfig", "assertSelfHosted", "CLAXEDO_DEPLOYMENT_MODE ==="]) {
      expect(body, `the shared core must not contain ${forbidden}`).not.toContain(forbidden)
    }
  })

  test("the core still mounts routes, so the assertions above are not vacuous", () => {
    // Positive control: if the extraction had left an empty function, every
    // "does not contain" assertion above would pass with no coverage.
    const body = bodyOf("createSignedControlPlaneApp")

    expect(body.split("app.route(").length - 1).toBeGreaterThan(10)
    expect(body).toContain("return app")
  })
})

describe("route ownership", () => {
  test("the shared core records its mounts under one owner", () => {
    // Unit 7 combines this core with deployment adapters. Two owners claiming
    // one prefix is silent in Hono, so composition records who mounted what.
    expect(bodyOf("createSignedControlPlaneApp")).toContain("withRouteOwnership(new Hono()")
  })
})
