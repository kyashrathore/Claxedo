import { CLAXEDO_MIGRATION_JOURNAL, configureClaxedoSchema } from "@claxedo/server-core/platform/db/index"
import { TASKS_SQLITE_SCHEMA } from "@claxedo/tasks/storage/sqlite"

configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL, TASKS_SQLITE_SCHEMA.journal] })
