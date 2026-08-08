import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

/**
 * What Host Connector is allowed to reach.
 *
 * This package runs on the user's machine, sometimes headless on a box the
 * owner does not watch. Its whole security story is that it holds one signing
 * key and speaks one small protocol — so what it depends on IS the security
 * story, not an implementation detail.
 *
 * The rule is stricter than any other package's: no server code, no control
 * plane, no database, no HTTP framework. A connector that imported
 * `@claxedo/server` would put the hosted control plane's dependency tree on
 * every enrolled laptop, and a connector that imported a server framework
 * would be one refactor away from listening.
 *
 * Enforced by reading imports rather than by review. This package is small
 * enough today that the rule looks obvious; it is enforced now precisely
 * because that is when the enforcement is cheap.
 */

const SRC = path.join(import.meta.dirname)

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry)
    if (statSync(file).isDirectory()) return sourceFiles(file)
    if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) return []
    return [file]
  })
}

/** Every import specifier in the package's production sources. */
function importSpecifiers() {
  const pattern = /(?:^|[\s;])(?:import|export)\b[^'"`;()]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
  return sourceFiles().flatMap((file) => {
    const text = readFileSync(file, "utf8")
    return [...text.matchAll(pattern)]
      .map((match) => match[1] ?? match[2] ?? match[3])
      .filter((specifier): specifier is string => !!specifier)
      .map((specifier) => ({ file: path.relative(SRC, file), specifier }))
  })
}

/** Bare package specifiers — anything not starting with `.` or `/`. */
function externalImports() {
  return importSpecifiers().filter((entry) => !entry.specifier.startsWith(".") && !entry.specifier.startsWith("/"))
}

describe("Host Connector's dependency closure", () => {
  test("imports no first-party package at all", () => {
    // Not "no server package" — none. Every Claxedo package it could import
    // pulls a tree the connector has no use for, and the protocol it speaks is
    // three signed strings.
    const offenders = externalImports().filter((entry) => entry.specifier.startsWith("@claxedo/"))

    expect(offenders).toEqual([])
  })

  test("imports no server framework, database, or control plane", () => {
    // A connector that imported a server framework is one refactor away from
    // listening, and a laptop that listens is the attack surface this design
    // avoids by making the connector a pure client.
    const forbidden = ["hono", "express", "convex", "better-auth", "better-sqlite3", "drizzle-orm", "@clerk/"]
    const offenders = externalImports().filter((entry) =>
      forbidden.some((name) => entry.specifier === name || entry.specifier.startsWith(name)),
    )

    expect(offenders).toEqual([])
  })

  test("uses Web Crypto rather than node:crypto", () => {
    // The connector runs under Node, Bun and Electron. `crypto.subtle` is the
    // one implementation all three share; a `node:crypto` import would work in
    // development and fail wherever the runtime differs.
    const offenders = externalImports().filter((entry) => entry.specifier.startsWith("node:crypto"))

    expect(offenders).toEqual([])
  })

  test("has no runtime dependencies declared", () => {
    // The closure above is about what the source imports. This is about what
    // installing the package would pull, and they can disagree — a dependency
    // added "for later" is one an audit has to explain.
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }

    expect(Object.keys(pkg.dependencies ?? {})).toEqual([])
  })

  test("the scanner actually reads this package's imports", () => {
    // Positive control. Every assertion above is "the offenders list is
    // empty", which is exactly what a scanner that found nothing would report.
    const found = importSpecifiers()

    expect(found.length).toBeGreaterThan(0)
    expect(found.map((entry) => entry.specifier)).toContain("./host-identity")
  })

  test("would notice a forbidden import if one appeared", () => {
    // Mutation check for the matcher itself, without editing a source file.
    const pattern = /(?:^|[\s;])(?:import|export)\b[^'"`;()]*?from\s*["']([^"']+)["']/g
    const sample = `import { Hono } from "hono"\nimport { x } from "@claxedo/server"`
    const specifiers = [...sample.matchAll(pattern)].map((match) => match[1])

    expect(specifiers).toEqual(["hono", "@claxedo/server"])
    expect(specifiers.filter((s) => s!.startsWith("@claxedo/"))).toEqual(["@claxedo/server"])
  })
})
