import { CLAXEDO_MIGRATION_JOURNAL, configureClaxedoSchema } from "@claxedo/server-core/platform/db/index"

// The host runtimes these tests serve read the machine's `claxedo.db`, which
// `claxedo connect` opens under the host journal alone.
configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL] })
