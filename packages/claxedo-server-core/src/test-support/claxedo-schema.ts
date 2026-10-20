import { configureClaxedoSchema } from "../platform/db/db"
import { CLAXEDO_MIGRATION_JOURNAL } from "../platform/db/journal"

configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL] })
