/**
 * Every path a README under `src/` names must exist.
 *
 * Docs that describe structure decay silently through exactly the kind of moves
 * this reorg made: nothing type-checks a README, so a file reference survives
 * long after its target has been renamed or deleted, and the next reader trusts
 * it. `authority/README.md` cited four modules that moved to `platform/auth/`,
 * and `src/README.md` pointed at `adapters/storage/`, a directory that has
 * never existed in this tree.
 *
 * Scope is deliberately narrow — backtick-quoted things that LOOK like paths in
 * this package. Prose, package names and URLs are not checked, because a guard
 * that fires on prose gets suppressed instead of read.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")
const PACKAGE_ROOT = path.resolve(SRC, "..")
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..")

/**
 * A backticked file path (`foo/bar.ts`), a nested directory (`foo/bar/`), or a
 * SINGLE-segment directory (`storage/`). Bare words with no slash and no source
 * extension are excluded — those are prose, not paths.
 *
 * The single-segment case is the one that matters most and was originally
 * missed: the first regex required a segment AFTER the final slash, so every
 * `adapters/`-style entry in the structure tables — exactly what a reorg
 * invalidates — was silently skipped. Only 24 of 109 code spans reached the
 * existence check.
 */
const CODE_SPAN = /`([^`\s]+)`/g
const LOOKS_LIKE_PATH =
  /^(?:[\w.@-]+\/)+[\w.*-]+\/?$|^[\w-]+\.(?:ts|tsx|mjs|json|sql|md)$|^[\w.-]+\/$/

function markdownFiles() {
  return walk(SRC).filter((file) => file.endsWith(".md"))
}

function resolves(ref: string, from: string) {
  const cleaned = ref.replace(/\/$/, "")
  return [
    path.resolve(path.dirname(from), cleaned),
    path.join(SRC, cleaned),
    path.join(PACKAGE_ROOT, cleaned),
    path.join(REPO_ROOT, cleaned),
    // Package-qualified, as document titles are written:
    // `claxedo-server/src/authority` names this package's own directory.
    path.join(REPO_ROOT, "packages", cleaned),
  ].some((candidate) => fs.existsSync(candidate))
}

/**
 * In a markdown table row the FIRST code span is the parent directory and the
 * rest are its children (`| \`platform/\` | ... | \`auth/\`, \`db/\` |`). Those
 * children are correct as written and only resolve underneath that parent, so
 * a row's first span becomes the base for the rest of the line.
 */
function rowParent(line: string) {
  if (!line.trimStart().startsWith("|")) return undefined
  const first = CODE_SPAN.exec(line)?.[1]
  CODE_SPAN.lastIndex = 0
  return first?.endsWith("/") ? first : undefined
}

function unresolvedRefs() {
  const bad: string[] = []
  for (const file of markdownFiles()) {
    const lines = fs.readFileSync(file, "utf8").split("\n")
    lines.forEach((line, index) => {
      const parent = rowParent(line)
      let first = true
      for (const match of line.matchAll(CODE_SPAN)) {
        const ref = match[1]!
        const isParent = first
        first = false
        // Not a path: a package specifier, a URL, a glob, or an env var.
        if (!LOOKS_LIKE_PATH.test(ref)) continue
        if (ref.startsWith("@") || ref.includes("://") || ref.includes("*")) continue
        if (resolves(ref, file)) continue
        if (!isParent && parent && resolves(`${parent}${ref}`, file)) continue
        bad.push(`${path.relative(SRC, file)}:${index + 1}  ${ref}`)
      }
    })
  }
  return bad.toSorted()
}

describe("docs paths resolve", () => {
  test("the check is not vacuous — READMEs exist under src/ and name paths", () => {
    expect(markdownFiles().length).toBeGreaterThan(0)
  })

  test("every path named in a README under src/ exists", () => {
    // A stale entry here is a doc telling a reader to open a file that is not
    // there. Fix the doc, or delete the claim.
    expect(unresolvedRefs()).toEqual([])
  })
})
