/**
 * The suite's claxedo database, with its schema already named.
 *
 * There is exactly one `claxedo.db` file format and exactly one journal for it,
 * so configuring it here is not a policy decision a product could get wrong —
 * it is the only correct answer. Importing this module is what makes the engine
 * safe to use.
 *
 * `configureClaxedoMigrations` remains exported for a deployment that ships a
 * different journal (a bundled build overrides it entirely), and the engine
 * still refuses to open with no journal named, so importing `./db` directly
 * fails loudly rather than opening a database with no tables.
 */

import { configureClaxedoMigrations } from "./db"
import { CLAXEDO_MIGRATION_JOURNAL } from "./journal"

configureClaxedoMigrations(CLAXEDO_MIGRATION_JOURNAL)

// Named rather than `export *`: `ClaxedoDB` is a namespace carrying the
// `Client` type, and a star re-export does not carry a namespace's types across
// a package boundary — every `db: ClaxedoDB.Client` parameter silently became
// `any`, which typechecks and is exactly wrong.
export { ClaxedoDB, configureClaxedoMigrations } from "./db"
export { eq, and, desc, gt, inArray } from "drizzle-orm"
export { CLAXEDO_MIGRATION_JOURNAL } from "./journal"
