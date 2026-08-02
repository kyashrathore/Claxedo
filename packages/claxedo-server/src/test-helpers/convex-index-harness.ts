/**
 * Index-faithful query support for the hand-rolled Convex `db` doubles.
 *
 * The doubles in this directory each grew their own `withIndex`, and every one
 * of them IGNORED the index name: `withIndex("by_anything", q => q.eq(...))`
 * behaved like a plain field filter. That makes them blind to the two mistakes
 * an index conversion can actually make — naming an index that does not exist,
 * and comparing fields in an order the index cannot serve — which are precisely
 * the mistakes the W5 pass could introduce. A double that accepts any index
 * name cannot verify a change from a scan to an index at all.
 *
 * So this module resolves index names against the REAL `convex/schema.ts` and
 * enforces the two rules Convex enforces:
 *
 *   1. The index must exist on the table being queried.
 *   2. Range fields must be stepped in index order — `.eq` on each leading
 *      field, and any inequality only on the field immediately after them.
 *
 * It is a semantics checker, not a performance model: matching is still a
 * linear pass over the seeded rows, because these tests assert RESULTS. What
 * they gain is that a query claiming to use an index has to be one the index
 * can serve.
 */
import fs from "node:fs"
import path from "node:path"

export type Row = Record<string, unknown> & { _id: string }

const schemaPath = path.resolve(import.meta.dirname, "../../../../convex/schema.ts")

/**
 * `table -> index name -> ordered field list`, parsed from the schema source.
 *
 * Parsed rather than imported because importing `convex/schema.ts` pulls in the
 * Convex server runtime and the generated data model; the index declarations
 * are a flat, regular shape in the source, and reading them keeps this harness
 * loadable from a plain vitest process.
 */
function parseSchemaIndexes() {
  const source = fs.readFileSync(schemaPath, "utf8")
  const tables = new Map<string, Map<string, string[]>>()
  // Table blocks: `name: defineTable({ ... })` followed by chained
  // `.index("name", ["field", ...])` calls up to the next table declaration.
  const tablePattern = /^ {2}(\w+):\s*defineTable\(/gm
  const starts = [...source.matchAll(tablePattern)]
  starts.forEach((match, position) => {
    const table = match[1]!
    const from = match.index!
    const to = position + 1 < starts.length ? starts[position + 1]!.index! : source.length
    const block = source.slice(from, to)
    const indexes = new Map<string, string[]>()
    for (const index of block.matchAll(/\.(?:index|searchIndex)\(\s*"([^"]+)"\s*,\s*\[([^\]]*)\]/g)) {
      const fields = [...index[2]!.matchAll(/"([^"]+)"/g)].map((field) => field[1]!)
      indexes.set(index[1]!, fields)
    }
    // Convex appends `_creationTime` to every index; a range may legally step
    // onto it after the declared fields.
    for (const [name, fields] of indexes) indexes.set(name, [...fields, "_creationTime"])
    tables.set(table, indexes)
  })
  return tables
}

const schemaIndexes = parseSchemaIndexes()

/**
 * Index/schema divergences this harness is willing to model rather than reject.
 *
 * EMPTY, and it should stay that way. It briefly held three entries: the
 * WorkGraph owner-deletion cascade queried `workgraph_dirty_events`,
 * `workgraph_agent_checkpoints`, and `workgraph_session_bindings` through a
 * `by_tenant` index none of them declared, so against the real Convex runtime
 * that cascade THREW on those tables and an owner deletion could not complete.
 * It survived review because every hand-rolled Convex `db` double ignored the
 * index NAME — the exact blind spot this harness exists to close.
 *
 * Fixed 2026-07-30 in `convex/workgraphOwnerDeletion.ts` by resolving each
 * table's index through `WORKGRAPH_OWNER_DELETION_INDEXES` rather than assuming
 * `by_tenant`; no schema change was needed, because all three already carried a
 * `["organization_id", "owner_user_id", …]`-prefixed index. The invariant is now
 * asserted directly (see the cascade tests in
 * `authority/convex-unbounded-read-guard.test.ts`), which is strictly better
 * than modelling the divergence here.
 *
 * An entry is a known BUG being tolerated, never an accepted exception — so
 * adding one needs a written reason and a plan to remove it.
 */
const KNOWN_MISSING_INDEXES = new Map<string, Map<string, string>>()

/** The divergences above, for a test that asserts the list has not grown. */
export function knownMissingIndexes() {
  return [...KNOWN_MISSING_INDEXES].flatMap(([table, entries]) =>
    [...entries.keys()].map((index) => `${table}.${index}`))
}

/** Index names declared on a table, for tests that assert a query can run. */
export function declaredIndexes(table: string) {
  const indexes = schemaIndexes.get(table)
  if (!indexes) throw new Error(`convex/schema.ts declares no table "${table}"`)
  return [...indexes.keys()]
}

export function indexFields(table: string, index: string) {
  const indexes = schemaIndexes.get(table)
  if (!indexes) throw new Error(`convex/schema.ts declares no table "${table}"`)
  const fields = indexes.get(index)
  if (!fields) {
    // A tolerated divergence still has to behave like SOME index so the suite
    // exercising it can run. Modelled as an index over exactly the tenancy
    // fields rather than inventing a schema, and recorded above as a bug.
    if (KNOWN_MISSING_INDEXES.get(table)?.has(index)) return ["organization_id", "owner_user_id", "_creationTime"]
    throw new Error(
      `convex/schema.ts declares no index "${index}" on "${table}" (has: ${[...indexes.keys()].join(", ")})`,
    )
  }
  return fields
}

type Check = (row: Row) => boolean

/**
 * Convex's total value order, enough of it for index ranges.
 *
 * `undefined` — a MISSING field — sorts below everything, which is what makes
 * `.gt(field, undefined)` mean "rows that have this field at all". Several W5
 * conversions depend on exactly that, so the double has to model it rather than
 * let a JS `>` comparison against undefined quietly return false for every row.
 */
function rank(value: unknown) {
  if (value === undefined) return 0
  if (value === null) return 1
  return 2
}

function compare(left: unknown, right: unknown) {
  const order = rank(left) - rank(right)
  if (order !== 0) return order
  if (rank(left) < 2) return 0
  if (typeof left === "number" && typeof right === "number") return left - right
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0
}

/**
 * The range builder, enforcing index-order stepping.
 *
 * `position` is how many fields have been pinned with `.eq` so far. Per Convex's
 * `IndexRangeBuilder`, a range is: zero or more `.eq` in index order, then
 * optionally a LOWER bound (`.gt`/`.gte`), then optionally an UPPER bound
 * (`.lt`/`.lte`) — both on the field immediately after the equalities. So one
 * lower plus one upper on the same field is legal (that is a bounded interval,
 * which the org purge queue uses), while `.eq` after a bound, or a second bound
 * on the same side, is not.
 */
export function indexRangeBuilder(table: string, index: string) {
  const fields = indexFields(table, index)
  const checks: Check[] = []
  let position = 0
  let lower = false
  let upper = false

  const expect = (method: string, field: string) => {
    const bound = method === "eq" ? "eq" : method === "gt" || method === "gte" ? "lower" : "upper"
    if (bound === "eq" && (lower || upper)) {
      throw new Error(`${table}.${index}: .eq("${field}") follows a range bound; equalities must come first`)
    }
    if (bound === "lower" && lower) throw new Error(`${table}.${index}: a second lower bound on "${field}"`)
    if (bound === "upper" && upper) throw new Error(`${table}.${index}: a second upper bound on "${field}"`)
    const wanted = fields[position]
    if (field !== wanted) {
      throw new Error(
        `${table}.${index}: .${method}("${field}") is out of index order — expected "${wanted}" (index is [${fields.join(", ")}])`,
      )
    }
    if (bound === "lower") lower = true
    if (bound === "upper") upper = true
  }

  const builder = {
    eq(field: string, value: unknown) {
      expect("eq", field)
      position += 1
      checks.push((row) => compare(row[field], value) === 0)
      return builder
    },
    gt(field: string, value: unknown) {
      expect("gt", field)
      checks.push((row) => compare(row[field], value) > 0)
      return builder
    },
    gte(field: string, value: unknown) {
      expect("gte", field)
      checks.push((row) => compare(row[field], value) >= 0)
      return builder
    },
    lt(field: string, value: unknown) {
      expect("lt", field)
      checks.push((row) => compare(row[field], value) < 0)
      return builder
    },
    lte(field: string, value: unknown) {
      expect("lte", field)
      checks.push((row) => compare(row[field], value) <= 0)
      return builder
    },
  }
  return { builder, checks }
}

/**
 * Order rows the way an index scan would: by the index's fields, ascending.
 *
 * Load-bearing for the org purge, whose starvation-free "oldest request first"
 * ordering came from a JS `.sort()` and now comes from the index. A double that
 * returned seed order would pass either way and prove nothing.
 */
export function orderByIndex(rows: Row[], table: string, index: string) {
  const fields = indexFields(table, index)
  return [...rows].sort((left, right) => {
    for (const field of fields) {
      const order = compare(left[field], right[field])
      if (order !== 0) return order
    }
    return 0
  })
}
