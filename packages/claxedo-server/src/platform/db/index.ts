/**
 * This product's claxedo database.
 *
 * The engine and the generated journal are the suite's — both server products
 * open the same `claxedo.db` file format. What is local to this package is the
 * ACT of naming the schema: importing this module configures the journal, so
 * there is no order in which a caller can open the database before its schema
 * is known. Every consumer inside this package goes through here rather than
 * reaching for the engine directly.
 */

import { configureClaxedoMigrations } from "@claxedo/server-core/platform/db/db"
import { CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/journal"

configureClaxedoMigrations(CLAXEDO_MIGRATION_JOURNAL)

export * from "@claxedo/server-core/platform/db/db"
