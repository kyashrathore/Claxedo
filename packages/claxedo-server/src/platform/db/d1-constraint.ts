export type D1ConstraintKind = "unique" | "check" | "not_null" | "foreign_key"

export type D1ConstraintFailure = {
  kind: D1ConstraintKind
  /** SQLite's description of what failed: `table.column[, table.column]`, `index 'name'`, or a CHECK expression. */
  target: string
}

const KINDS: Record<string, D1ConstraintKind> = {
  UNIQUE: "unique",
  CHECK: "check",
  "NOT NULL": "not_null",
  "FOREIGN KEY": "foreign_key",
}

const CONSTRAINT_FAILED = /\b(UNIQUE|CHECK|NOT NULL|FOREIGN KEY) constraint failed(?:: (.*?))?(?:: SQLITE_|$)/

/**
 * The constraint a D1 statement or batch was refused by. D1 errors carry no
 * result-code field: the SQLite failure exists only as text on the error or its
 * `cause`, e.g. `D1_ERROR: UNIQUE constraint failed: index 'u_k': SQLITE_CONSTRAINT
 * (extended: SQLITE_CONSTRAINT_UNIQUE)` under Miniflare. This is the one place
 * that text is read; callers branch on the typed result.
 */
export function d1ConstraintFailure(error: unknown): D1ConstraintFailure | undefined {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    const match = CONSTRAINT_FAILED.exec(current.message)
    if (match) return { kind: KINDS[match[1]!]!, target: match[2]?.trim() ?? "" }
  }
  return undefined
}

export function d1UniqueFailureOn(error: unknown, table: string): boolean {
  const failure = d1ConstraintFailure(error)
  return failure?.kind === "unique" && failure.target.split(", ").some((column) => column.startsWith(`${table}.`))
}

/** A guarded batch aborted on its `authority_batch_assertions` row, whose `check (passed = 1)` refused a 0. */
export function d1BatchAssertionFailed(error: unknown): boolean {
  const failure = d1ConstraintFailure(error)
  return failure?.kind === "check" && failure.target === "passed = 1"
}
