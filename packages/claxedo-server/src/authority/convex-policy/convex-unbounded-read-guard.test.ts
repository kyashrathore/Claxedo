import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { declaredIndexes, indexFields, knownMissingIndexes } from "../../test-helpers/convex-index-harness"
import {
  WORKGRAPH_OWNER_DELETION_INDEXES,
  WORKGRAPH_OWNER_TABLES,
  ownerDeletionIndex,
} from "../../../../../convex/workgraphOwnerDeletion"

// W5.6 standing guard — no unbounded reads in Convex (cf-reliability review A3).
//
// Convex caps the documents one transaction may read. A query that reads a
// whole table therefore does NOT get slower as that table grows — it THROWS,
// and it throws first on whichever path has the most rows behind it, which in
// this codebase means a cron sweep or a tenant's create path. The failure looks
// like an outage, not like capacity.
//
// So `.collect()` is only safe when something upstream in the same chain bounds
// what it collects: a `.withIndex(...)` range, or a `.withSearchIndex(...)`.
// `.filter()` deliberately does not count — Convex's `.filter()` reads every
// document and discards non-matches, so it narrows the RESULT while leaving the
// read-set the whole table. That distinction is the entire bug class this guard
// exists to catch, and it is invisible at the call site.
//
// This is the third drift guard of its shape, after `worker-cron-drift.test.ts`
// and `relay-config-drift.test.ts`: parse the source, assert the invariant,
// keep an explicit allowlist so an exception has to be argued for in writing
// rather than merged by being unnoticed.

const repoRoot = path.resolve(import.meta.dirname, "../../../../..")
const convexRoot = path.join(repoRoot, "convex")

/**
 * Deliberate unbounded reads: `file.ts` → enclosing function name → why.
 *
 * Keyed on the FUNCTION rather than a line number on purpose — a line-numbered
 * allowlist silently retargets the moment anything above it moves, which would
 * let an unrelated edit inherit an exception someone argued for elsewhere.
 *
 * The bar for an entry: the read must be bounded by something the guard cannot
 * see, and the reason must say what. "The table is small today" is not a
 * reason — that was the standing comment on both `countActiveForOrg` and
 * `flagStaleBillingSync`, and it was wrong in the same way in both.
 *
 * This starts EMPTY on purpose. Every site the W5 pass touched was either
 * convertible to an index range or bounded with `.take()`; none needed an
 * exception. An addition here should be rarer than a schema change.
 */
const ALLOWED_UNBOUNDED_READS = new Map<string, Map<string, string>>()

function convexModules() {
  return fs.readdirSync(convexRoot)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => ({
      file,
      source: fs.readFileSync(path.join(convexRoot, file), "utf8"),
    }))
}

/**
 * Blank out comments and string literals, preserving line structure.
 *
 * Without this the guard reports its own explanatory prose: several of the
 * converted sites carry comments that name `.collect()` to say why they no
 * longer call it. Newlines are kept so reported line numbers stay real, and
 * replaced spans become spaces rather than being deleted so column offsets do
 * not shift.
 */
function stripCommentsAndStrings(source: string) {
  let out = ""
  let index = 0
  const blank = (text: string) => text.replace(/[^\n]/g, " ")
  while (index < source.length) {
    const rest = source.slice(index)
    const block = rest.match(/^\/\*[\s\S]*?\*\//)
    if (block) {
      out += blank(block[0])
      index += block[0].length
      continue
    }
    const line = rest.match(/^\/\/[^\n]*/)
    if (line) {
      out += blank(line[0])
      index += line[0].length
      continue
    }
    // Strings and template literals. Templates may span lines and may nest
    // expressions; blanking the whole literal is fine here because a query
    // chain never lives inside one.
    const literal = rest.match(/^("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/)
    if (literal) {
      out += blank(literal[0])
      index += literal[0].length
      continue
    }
    out += source[index]
    index += 1
  }
  return out
}

/**
 * Every `.collect()` in a module, paired with the query chain reaching it.
 *
 * A chain is walked BACKWARDS from the `.collect()` to the `.query(` that opens
 * it, so multi-line chains — which is how nearly all of these are written — are
 * judged whole. The chain text between those two points is what must contain
 * the bound.
 */
function collectCallSites(source: string) {
  const code = stripCommentsAndStrings(source)
  const lines = code.split("\n")
  const sites: Array<{ line: number; chain: string; fn: string }> = []
  lines.forEach((text, index) => {
    if (!text.includes(".collect()")) return
    // Walk up until the line that opens the chain. `.query(` is how every
    // Convex table read starts; the cap keeps a pathological file from making
    // this quadratic and is far beyond any real chain's length.
    let chain = ""
    for (let cursor = index; cursor >= 0 && cursor > index - 40; cursor -= 1) {
      chain = `${lines[cursor]}\n${chain}`
      if (/\.query\s*\(/.test(lines[cursor]!)) break
    }
    sites.push({ line: index + 1, chain, fn: enclosingFunction(lines, index) })
  })
  return sites
}

/**
 * Nearest declaration above a line — the allowlist's key.
 *
 * Matches the two shapes convex/ uses: an exported Convex function
 * (`export const name = serviceQuery({`) and a plain module-level helper
 * (`async function name(`). Falling back to the line number keeps an
 * unrecognized shape allowlistable rather than un-suppressible, while still
 * being specific enough that it cannot silently cover a different site.
 */
function enclosingFunction(lines: string[], index: number) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const declaration = lines[cursor]!.match(
      /^(?:export\s+)?(?:const|(?:async\s+)?function)\s+(\w+)/,
    )
    if (declaration) return declaration[1]!
  }
  return `line:${index + 1}`
}

function isBounded(chain: string) {
  return /\.with(Index|SearchIndex)\s*\(/.test(chain)
}

/** `file.ts:LINE` plus the offending source line, for a message that locates. */
function describeSite(file: string, line: number, fn: string, source: string) {
  const text = source.split("\n")[line - 1]?.trim() ?? ""
  return `convex/${file}:${line} (${fn}): ${text}`
}

function unboundedReads() {
  const violations: string[] = []
  for (const { file, source } of convexModules()) {
    const allowed = ALLOWED_UNBOUNDED_READS.get(file)
    for (const site of collectCallSites(source)) {
      if (isBounded(site.chain)) continue
      if (allowed?.has(site.fn)) continue
      violations.push(describeSite(file, site.line, site.fn, source))
    }
  }
  return violations
}

describe("Convex unbounded-read guard (W5.6)", () => {
  test("every .collect() is bounded by an index range", () => {
    // The message on failure is the fix: add `.withIndex(...)` narrowing the
    // read to the rows the handler actually wants, switch to
    // `.take()`/`.paginate()` if the read is genuinely an enumeration, or add
    // the site to ALLOWED_UNBOUNDED_READS with a written reason.
    expect(unboundedReads()).toEqual([])
  })

  test("no allowlist entry is stale", () => {
    // An exception that no longer suppresses anything is worse than noise: it
    // reads as license for the next unbounded read in that function. Ratchet
    // it down by deleting the entry when the site is fixed or moves.
    const stale: string[] = []
    for (const { file, source } of convexModules()) {
      const allowed = ALLOWED_UNBOUNDED_READS.get(file)
      if (!allowed) continue
      const unbounded = new Set(collectCallSites(source)
        .filter((site) => !isBounded(site.chain))
        .map((site) => site.fn))
      for (const fn of allowed.keys()) {
        if (!unbounded.has(fn)) stale.push(`convex/${file}: ${fn}`)
      }
    }
    const present = new Set(convexModules().map(({ file }) => file))
    for (const file of ALLOWED_UNBOUNDED_READS.keys()) {
      if (!present.has(file)) stale.push(`convex/${file}: module no longer exists`)
    }
    expect(stale).toEqual([])
  })

  // The harness models NO divergence any more. It briefly tolerated three (the
  // owner-deletion cascade's missing `by_tenant` indexes), all now fixed by
  // resolving each table's index explicitly — see the cascade suite below.
  //
  // Ratchet: this may only ever go DOWN. An entry means a known bug is being
  // tolerated, so a non-empty list has to be argued for in the harness itself.
  test("the harness tolerates no missing-index divergences", () => {
    expect(knownMissingIndexes()).toEqual([])
  })

  test("every allowlist entry carries a written reason", () => {
    const empty: string[] = []
    for (const [file, entries] of ALLOWED_UNBOUNDED_READS) {
      for (const [fn, reason] of entries) {
        if (reason.trim().length < 40) empty.push(`convex/${file}: ${fn}`)
      }
    }
    expect(empty).toEqual([])
  })
  // POSITIVE CONTROL. A guard that has never been seen to fail is a guard
  // nobody has checked, and this one leans on hand-rolled parsing where a
  // silent over-match would make every future violation invisible.
  //
  // These run the same predicates the test above runs, against fixtures rather
  // than against the tree, so they prove the guard has teeth without needing a
  // real regression committed to convex/.
  describe("the guard's own teeth", () => {
    test("a bare .collect() is reported", () => {
      const source = `const rows = await ctx.db.query("orgs").collect()\n`
      const sites = collectCallSites(source)
      expect(sites).toHaveLength(1)
      expect(isBounded(sites[0]!.chain)).toBe(false)
    })

    test("a multi-line indexed chain is accepted", () => {
      const source = [
        `const rows = await ctx.db`,
        `  .query("orgs")`,
        `  .withIndex("by_clerk_org_id", (q) => q.eq("clerk_org_id", id))`,
        `  .collect()`,
        ``,
      ].join("\n")
      const sites = collectCallSites(source)
      expect(sites).toHaveLength(1)
      expect(isBounded(sites[0]!.chain)).toBe(true)
    })

    test("a .filter() chain is reported: filter does not bound the read", () => {
      // The exact shape `wakes.listFiringWakes` had. It reads like a narrowed
      // query and is a full table scan.
      const source = [
        `const docs = await ctx.db`,
        `  .query("wakes")`,
        `  .filter((q) => q.eq(q.field("state"), "firing"))`,
        `  .collect()`,
        ``,
      ].join("\n")
      const sites = collectCallSites(source)
      expect(sites).toHaveLength(1)
      expect(isBounded(sites[0]!.chain)).toBe(false)
    })

    test("a .collect() named only in a comment or a string is not reported", () => {
      // Otherwise the guard fails on the W5 comments explaining why a site
      // stopped calling `.collect()`, and the cure is to delete the
      // explanations — which is how a guard trains people to write worse code.
      const source = [
        `// \`.take()\` rather than \`.collect()\`: the read-set stays bounded.`,
        `/* Historically a .collect() over the whole table. */`,
        `const label = "call .collect() here"`,
        ``,
      ].join("\n")
      expect(collectCallSites(source)).toEqual([])
    })

    test("an indexed chain mentioning .collect() in a nested string is still judged on code", () => {
      const source = [
        `const rows = await ctx.db`,
        `  .query("orgs")`,
        `  .withIndex("by_owner", (q) => q.eq("owner_user_id", id))`,
        `  .collect()`,
        ``,
      ].join("\n")
      const sites = collectCallSites(source)
      expect(sites.map((site) => site.line)).toEqual([4])
    })

    test("two collects in one module are judged independently", () => {
      const source = [
        `const a = await ctx.db.query("orgs").withIndex("by_owner", (q) => q.eq("owner_user_id", id)).collect()`,
        `const b = await ctx.db.query("orgs").collect()`,
        ``,
      ].join("\n")
      const sites = collectCallSites(source)
      expect(sites.map((site) => [site.line, isBounded(site.chain)]))
        .toEqual([[1, true], [2, false]])
    })
  })
})

/**
 * The owner-deletion cascade's index mapping (fixed 2026-07-30).
 *
 * `deleteOwnerRecordBatch` enumerates 37 tables, and it used to name `by_tenant`
 * for all but one of them. Three tables never declared it, so against the real
 * Convex runtime the cascade THREW on those tables and an owner deletion could
 * not run to completion — rows it was meant to erase stayed. This suite asserts
 * the invariant the old inline ternary only assumed.
 *
 * A schema-shaped test rather than an execution-shaped one, deliberately: the
 * bug is "the named index does not exist", which is a property of the pair
 * (query, schema). Executing the cascade against a double proves less, because a
 * double has to be told what the indexes are — that is precisely how this went
 * unnoticed for so long.
 */
describe("WorkGraph owner-deletion cascade index mapping", () => {
  // The tenancy prefix every owner-scoped read must pin. `deleteOwnerRecordBatch`
  // compares exactly these two fields, in this order.
  const TENANT_PREFIX = ["organization_id", "owner_user_id"]

  test("every cascade table declares the index the cascade resolves for it", () => {
    // The regression, stated directly: a table whose resolved index is absent
    // from the schema makes the cascade throw at runtime.
    const missing = WORKGRAPH_OWNER_TABLES
      .map((table) => ({ table, index: ownerDeletionIndex(table) }))
      .filter(({ table, index }) => !declaredIndexes(table).includes(index))
      .map(({ table, index }) => `${table}: no index "${index}" (has: ${declaredIndexes(table).join(", ")})`)

    expect(missing).toEqual([])
  })

  test("each resolved index is tenant-scoped, so the cascade cannot cross tenants", () => {
    // The dangerous failure is not only "throws" — an index that does NOT lead
    // with the tenancy fields would let a two-`eq` prefix range match another
    // tenant's rows and delete them. Assert the prefix, not just existence.
    const wrongScope: string[] = []
    for (const table of WORKGRAPH_OWNER_TABLES) {
      const fields = indexFields(table, ownerDeletionIndex(table))
      if (table === "workgraph_tenancy_migration_quarantine") {
        // Owner-scoped only, by design: these rows have no resolvable
        // organization, which is why the table exists.
        if (fields[0] !== "owner_user_id") wrongScope.push(`${table}: leads with "${fields[0]}", expected owner_user_id`)
        continue
      }
      if (fields[0] !== TENANT_PREFIX[0] || fields[1] !== TENANT_PREFIX[1]) {
        wrongScope.push(`${table}: index leads [${fields.slice(0, 2).join(", ")}], expected [${TENANT_PREFIX.join(", ")}]`)
      }
    }
    expect(wrongScope).toEqual([])
  })

  test("deletion completeness: no trailing index field can exclude a tenant's row", () => {
    // A two-`eq` prefix range returns every row with that prefix REGARDLESS of
    // the trailing fields — that is what makes `by_token` and `by_tenant_id`
    // valid substitutes for `by_tenant` here. The one way that breaks is if a
    // trailing field were optional AND Convex excluded absent values; it does
    // not (a missing field sorts below every value and is still indexed), so an
    // unconstrained suffix cannot drop a row. This test pins the substitution
    // itself: every non-default mapping must be a strict tenancy-prefixed index,
    // never an index that merely mentions the tenancy fields somewhere.
    const suspect: string[] = []
    for (const [table, index] of Object.entries(WORKGRAPH_OWNER_DELETION_INDEXES)) {
      if (table === "workgraph_tenancy_migration_quarantine") continue
      const fields = indexFields(table, index)
      if (fields.indexOf("organization_id") !== 0 || fields.indexOf("owner_user_id") !== 1) {
        suspect.push(`${table}.${index}: [${fields.join(", ")}]`)
      }
    }
    expect(suspect).toEqual([])
  })

  test("the mapping carries no entry for a table the cascade does not enumerate", () => {
    // A stale entry is a silent no-op that reads as coverage.
    const enumerated = new Set<string>(WORKGRAPH_OWNER_TABLES)
    const orphaned = Object.keys(WORKGRAPH_OWNER_DELETION_INDEXES).filter((table) => !enumerated.has(table))
    expect(orphaned).toEqual([])
  })

  // POSITIVE CONTROL for this suite: the assertions must fail for a table whose
  // resolved index is absent, which is exactly the state the cascade shipped in.
  test("the mapping checks fail for an index a table does not declare", () => {
    expect(declaredIndexes("workgraph_dirty_events")).not.toContain("by_tenant")
    expect(() => indexFields("workgraph_dirty_events", "by_tenant")).toThrow(/declares no index/)
    // And the fix is what makes it pass: the resolver now returns `by_token`.
    expect(ownerDeletionIndex("workgraph_dirty_events")).toBe("by_token")
    expect(declaredIndexes("workgraph_dirty_events")).toContain("by_token")
  })
})
