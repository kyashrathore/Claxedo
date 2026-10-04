import path from "path"

/**
 * The Claxedo suite's migration journal.
 *
 * Both server products open the same `claxedo.db` file format, so its schema is
 * the suite's, not either product's. The generated SQL lives here where both can
 * reach it; the `*.sql.ts` table definitions it is generated FROM stay with the
 * domains that own them, because those are a generation-time input and this is
 * the runtime artifact.
 *
 * A composition still has to name this explicitly — see
 * `configureClaxedoMigrations`. Self-configuring here would buy nothing and
 * lose the guarantee that a database cannot open before its schema is known.
 */
export const CLAXEDO_MIGRATION_JOURNAL = path.join(import.meta.dirname, "claxedo-migration")
