import type { SessionInventoryRow } from "../types"

/**
 * A complete `SessionInventoryRow` from the few fields a test cares about.
 *
 * The inventory groups rows by `directory`/`workspaceId`/`projectID` and orders
 * them by `time`; every other required field is noise a fixture would otherwise
 * repeat. Three test files each kept their own copy of these defaults, and one
 * of them silently omitted `tags` — a type error test files never typecheck.
 */
export function sessionRow(
  input: Partial<SessionInventoryRow> & Pick<SessionInventoryRow, "id" | "directory">,
): SessionInventoryRow {
  return {
    title: input.id,
    projectID: input.directory,
    tags: [],
    attachments: [],
    time: { created: 1, updated: 1 },
    ...input,
  }
}
