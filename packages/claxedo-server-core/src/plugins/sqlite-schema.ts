import { CLAXEDO_MIGRATION_JOURNAL } from "../platform/db/journal"
import type { LocalServerPlugin } from "./server-plugin"

/**
 * Every journal `configureClaxedoSchema` is handed for a local composition: the
 * host's, then each plugin's. Kept apart from the plugin contract because the
 * host journal's directory is resolved from `import.meta.dirname` when this
 * module loads, which a Workers isolate cannot do.
 */
export function claxedoSchemaJournals(plugins: readonly LocalServerPlugin[]): readonly string[] {
  return [CLAXEDO_MIGRATION_JOURNAL, ...plugins.flatMap((plugin) => (plugin.sqliteSchema ? [plugin.sqliteSchema.journal] : []))]
}
