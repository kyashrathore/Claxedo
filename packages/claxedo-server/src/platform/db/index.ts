/**
 * The claxedo database, re-exported from `@claxedo/server-core`. The
 * composition that opens it names its migration journals first
 * (`configureClaxedoSchema`); the engine throws rather than open a database
 * with no schema.
 *
 * Named rather than `export *`: `ClaxedoDB` is a namespace carrying the
 * `Client` type, and a star re-export does not carry a namespace's types
 * through two hops — every `db: ClaxedoDB.Client` parameter silently became
 * `any`.
 */

export { ClaxedoDB, configureClaxedoSchema, CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/index"
export { eq, and, desc, gt, inArray } from "drizzle-orm"
