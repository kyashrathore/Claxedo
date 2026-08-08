/**
 * The claxedo database.
 *
 * Re-exported from `@claxedo/server-core` so every consumer in this package
 * reaches the engine through a module that has already named the suite's
 * migration journal. Importing the engine directly would open a database with
 * no schema — and the engine throws rather than let that happen.
 *
 * Named rather than `export *`: `ClaxedoDB` is a namespace carrying the
 * `Client` type, and a star re-export does not carry a namespace's types
 * through two hops — every `db: ClaxedoDB.Client` parameter silently became
 * `any`.
 */

export { ClaxedoDB, configureClaxedoMigrations, CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/index"
export { eq, and, desc, gt, inArray } from "drizzle-orm"
