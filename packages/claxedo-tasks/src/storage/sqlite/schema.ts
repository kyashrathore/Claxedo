import path from "node:path"
import type { SqliteSchemaContribution } from "@claxedo/server-core/plugins/server-plugin"

/**
 * The Tasks tables' migration journal. The directory carries the plugin's own
 * name because a bundled server copies every journal beside its chunks, where
 * a generic name would collide.
 */
export const TASKS_SQLITE_SCHEMA: SqliteSchemaContribution = {
  id: "claxedo-tasks",
  journal: path.join(import.meta.dirname, "claxedo-tasks-migration"),
}
