/**
 * This product's claxedo database.
 *
 * The engine is generic; the SCHEMA is not. `claxedo-migration/` holds product
 * DDL — documents, credentials, connections, channels — and lives here, beside
 * the `*.sql.ts` table definitions it is generated from.
 *
 * Importing this module names the journal. Every consumer inside this package
 * goes through here rather than reaching for the engine directly, so there is
 * no order in which a caller can open the database before its schema is known.
 */

import path from "path"
import { configureClaxedoMigrations } from "@claxedo/server-core/platform/db/db"

configureClaxedoMigrations(path.join(import.meta.dirname, "claxedo-migration"))

export * from "@claxedo/server-core/platform/db/db"
