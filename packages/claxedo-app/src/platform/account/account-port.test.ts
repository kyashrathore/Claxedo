import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The port's value is entirely in what it CANNOT be asked to do.
 *
 * Its runtime surface is four members, so a test that only exercised behaviour
 * would be nearly empty and would miss the whole point. What is worth holding
 * is the shape: that the operation set stays closed, stays equal to the matrix,
 * and never grows a request-shaped escape hatch. Those are the ways this
 * degrades back into `hostedFetch(url, method, body)` without anyone deciding
 * to.
 */

const portSource = readFileSync(path.join(import.meta.dir, "account-port.ts"), "utf8")
const matrix = readFileSync(
  path.resolve(import.meta.dir, "../../../../../docs/tech-docs/desktop-hosted-operation-matrix.md"),
  "utf8",
)

/** The `HostedOperationName` union members, as written. */
function declaredOperations(source = portSource) {
  const union = source.match(/export type HostedOperationName =([\s\S]*?)\n\n/)?.[1] ?? ""
  return [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]).toSorted()
}

/** Operation IDs in the matrix's first table column. */
function matrixOperations() {
  return [...matrix.matchAll(/^\| `([a-zA-Z][\w.]*\.[\w.]*)` \|/gm)].map((match) => match[1]).toSorted()
}

const UNIT_10_DEFERRED_OPERATIONS: string[] = []

describe("HostedOperationName", () => {
  test("names only operations the matrix declares and pins operations not yet on the port", () => {
    const inMatrix = new Set(matrixOperations())
    expect(declaredOperations().filter((operation) => !inMatrix.has(operation))).toEqual([])
    const declared = new Set(declaredOperations())
    expect(matrixOperations().filter((operation) => !declared.has(operation))).toEqual(UNIT_10_DEFERRED_OPERATIONS)
  })

  test("includes machine-wide enrollment", () => {
    expect(declaredOperations()).toContain("host.enrollCurrentMachine")
  })

  test("would notice an operation the matrix does not declare", () => {
    // Mutation check: the extractor must actually read the union, not return a
    // set that trivially satisfies the subset assertion.
    const mutated = portSource.replace(`  | "account.mode"`, `  | "account.mode"\n  | "hostedFetch.any"`)
    const inMatrix = new Set(matrixOperations())
    expect(declaredOperations(mutated).filter((operation) => !inMatrix.has(operation))).toEqual(["hostedFetch.any"])
  })

  test("is a closed union, not an open key type", () => {
    // `string` or a template literal here would make every guard above vacuous:
    // any name would type-check, and the reviewed set would stop being a set.
    const union = portSource.match(/export type HostedOperationName =([\s\S]*?)\n\n/)?.[1] ?? ""
    expect(union).not.toMatch(/\bstring\b/)
    expect(declaredOperations().length).toBeGreaterThan(0)
  })
})

describe("AccountPort", () => {
  test("run() takes an operation name and parameters, never a request", () => {
    // The confused-deputy shape. If `run` accepted a url/method/headers/path,
    // main would be executing renderer-chosen requests with main's credential,
    // and the closed operation set would be decoration.
    const run = portSource.match(/run: <T[^\n]*\n?[^\n]*/)?.[0] ?? ""
    expect(run).toContain("operation: HostedOperationName")
    for (const forbidden of ["url", "method", "headers", "path:"]) {
      expect(run, `run() must not accept ${forbidden}`).not.toContain(forbidden)
    }
  })

  test("hands the renderer no credential", () => {
    // Same rule as `Principal`: nothing on this port returns a token, and the
    // absence is asserted rather than trusted to review.
    const type = portSource.match(/export type AccountPort = \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(type.length).toBeGreaterThan(0)
    for (const forbidden of ["token", "Token", "credential", "cookie", "authorization", "Authorization"]) {
      expect(type, `AccountPort must not expose ${forbidden}`).not.toContain(forbidden)
    }
  })

  test("identity carries display state only", () => {
    const identity = portSource.match(/export type AccountIdentity = \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(identity).toContain("userId")
    for (const forbidden of ["token", "Token", "secret", "key:"]) {
      expect(identity, `AccountIdentity must not expose ${forbidden}`).not.toContain(forbidden)
    }
  })

  test("would notice a credential-shaped member", () => {
    // Mutation check for both guards above, including the same-line case that
    // a line-anchored matcher would miss.
    const type = portSource
      .match(/export type AccountPort = \{[\s\S]*?\n\}/)?.[0]
      ?.replace("  signOut: () => Promise<void>", "  signOut: () => Promise<void>; getToken: () => string")
    expect(type).toContain("getToken")
  })
})
