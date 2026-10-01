import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dirname)

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry)
    if (statSync(file).isDirectory()) return sourceFiles(file)
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) return []
    return [file]
  })
}

/** Every import specifier in the package's production sources. */
function importSpecifiers() {
  const pattern =
    /(?:^|[\s;])(?:import|export)\b[^'"`;()]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
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
  test("imports only the machine wire contract from first-party packages", () => {
    const allowed = new Set(["@claxedo/account-contract/machine", "@claxedo/account-contract/machine-seal"])
    const offenders = externalImports().filter(
      (entry) => entry.specifier.startsWith("@claxedo/") && !allowed.has(entry.specifier),
    )

    expect(offenders).toEqual([])
  })

  test("imports no server framework, database, or control plane", () => {
    // A connector that imported a server framework is one refactor away from
    // listening, and a laptop that listens is the attack surface this design
    // avoids by making the connector a pure client.
    const forbidden = ["hono", "express", "better-auth", "better-sqlite3", "drizzle-orm"]
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

  test("touches Node's filesystem only through the one adapter entry", () => {
    // `host-state-node.ts` is the deliberate exception, on its own export so
    // the desktop's utility child never imports it. Every other module stays
    // runtime-neutral: the state store takes its fs injected.
    const offenders = externalImports().filter(
      (entry) => entry.specifier.startsWith("node:") && entry.file !== "host-state-node.ts",
    )

    expect(offenders).toEqual([])
    expect(
      externalImports()
        .filter((entry) => entry.file === "host-state-node.ts")
        .map((entry) => entry.specifier),
    ).toEqual(["node:fs/promises"])
  })

  test("declares only the shared wire contract as a runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }

    expect(pkg.dependencies).toEqual({ "@claxedo/account-contract": "workspace:*" })
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
    expect(specifiers.filter((s) => s.startsWith("@claxedo/"))).toEqual(["@claxedo/server"])
  })
})
