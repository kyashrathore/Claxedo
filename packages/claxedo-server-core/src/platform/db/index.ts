/**
 * The suite's claxedo database engine.
 *
 * It does not name its own schema: the host journal and each composed plugin's
 * journal are the composition's to configure with `configureClaxedoSchema`
 * before anything opens the database, and the engine refuses to open with no
 * journal named.
 */

// Named rather than `export *`: `ClaxedoDB` is a namespace carrying the
// `Client` type, and a star re-export does not carry a namespace's types across
// a package boundary — every `db: ClaxedoDB.Client` parameter silently became
// `any`, which typechecks and is exactly wrong.
export { ClaxedoDB, configureClaxedoSchema } from "./db"
// Typed reads over the raw driver, for the queries drizzle's builder cannot
// express. They exist so a hand-written SQL result is narrowed once, here,
// instead of asserted into a row shape at each call site.
export { numberColumn, queryRow, queryRows, textColumn, textColumns } from "./db"
export { eq, and, desc, gt, inArray, isNull, lt, or } from "drizzle-orm"
export { CLAXEDO_MIGRATION_JOURNAL } from "./journal"
