/**
 * No `declare` class fields in server source.
 *
 * The defect this prevents: Playwright loads server modules through its own
 * babel transform, which parses TypeScript but does not run
 * `@babel/plugin-transform-typescript` unless configured. A `declare` class
 * field is a syntax error to that transform:
 *
 *   SyntaxError: TypeScript 'declare' fields must first be transformed by
 *   @babel/plugin-transform-typescript.
 *
 * It fails at PARSE time, so the whole module tree behind it disappears and the
 * e2e runner reports "No tests found" rather than a type error. `tsc` and the
 * unit runners accept the syntax happily, so nothing before the e2e job catches
 * it — which is exactly how four of these reached `dev`.
 *
 * The fix is never to drop the narrowing: declare it by merging an interface of
 * the same name beside the class. That is purely type-level, produces identical
 * narrowing, and erases under any transform.
 *
 *   export interface FooError { readonly code: FooErrorCode }
 *   export class FooError extends ClaxedoError { ... }
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")

/**
 * Matches `declare` fields INSIDE a class body — indented, and naming a field
 * rather than opening a block. Ambient module/global declarations (`declare
 * module "*.md" {`, `declare global {`) and top-level `declare const` are
 * untouched by this defect: they sit at column 0 and babel strips them.
 */
const DECLARE_CLASS_FIELD = /^[ \t]+declare\s+(?:readonly\s+)?[A-Za-z_$][\w$]*\s*[?!]?\s*:/

function declareClassFields() {
  const found: string[] = []
  for (const file of walk(SRC).filter((entry) => entry.endsWith(".ts"))) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.forEach((line, index) => {
      if (DECLARE_CLASS_FIELD.test(line)) {
        found.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  return found
}

describe("declare class fields", () => {
  test("no production or test source uses one", () => {
    expect(declareClassFields()).toEqual([])
  })

  /**
   * The scan above passes trivially if it walks nothing or the pattern never
   * matches, which is how a guard rots into decoration. These pin both halves:
   * the corpus is real, and the pattern fires on the exact line CI rejected
   * while leaving the ambient forms this codebase legitimately uses alone.
   */
  test("the scan reaches a real corpus", () => {
    const files = walk(SRC).filter((entry) => entry.endsWith(".ts"))
    expect(files.length).toBeGreaterThan(100)
  })

  test("the pattern catches the shape that broke CI", () => {
    expect(DECLARE_CLASS_FIELD.test("  declare readonly code: CliSessionTokenErrorCode")).toBe(true)
    expect(DECLARE_CLASS_FIELD.test("  declare readonly status: 503")).toBe(true)
    expect(DECLARE_CLASS_FIELD.test("\tdeclare foo: string")).toBe(true)
    expect(DECLARE_CLASS_FIELD.test("  declare bar?: number")).toBe(true)
  })

  test("the pattern leaves ambient declarations alone", () => {
    expect(DECLARE_CLASS_FIELD.test('declare module "*.md" {')).toBe(false)
    expect(DECLARE_CLASS_FIELD.test("declare global {")).toBe(false)
    expect(DECLARE_CLASS_FIELD.test("declare const CLAXEDO_MIGRATIONS: string[]")).toBe(false)
    expect(DECLARE_CLASS_FIELD.test("  const declared: string = x")).toBe(false)
  })
})
