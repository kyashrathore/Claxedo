import { CLAXEDO_MIGRATION_JOURNAL, configureClaxedoSchema } from "@claxedo/server-core/platform/db/index"

// The local backends these tests drive keep their index in the host's `claxedo.db`.
configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL] })
