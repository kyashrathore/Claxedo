import { describe, expect, test } from "bun:test"
import type { SessionInventoryRow } from "../../shared/query/types"
import { hasSessionIdentity, insertSortedSessionItem, removeSessionIdentity } from "./global-session-identity"

function item(id: string, directory: string, updated: number): SessionInventoryRow {
  return {
    id,
    directory,
    title: `${directory}:${id}`,
    projectID: "project",
    tags: [],
    attachments: [],
    time: { created: updated, updated },
  }
}

describe("global session identity", () => {
  test("keeps identical root ids separate across workspace scopes", () => {
    const local = item("ses_1", "/repo", 1)
    const cloud = item("ses_1", "workspace:ws_1", 2)

    expect(hasSessionIdentity([local], cloud)).toBe(false)
    expect(insertSortedSessionItem([local], cloud)).toEqual([cloud, local])
    expect(removeSessionIdentity([cloud, local], cloud)).toEqual([local])
  })

  test("replaces the matching root session row", () => {
    const stale = item("ses_1", "workspace:ws_1", 1)
    const fresh = item("ses_1", "workspace:ws_1", 3)
    const other = item("ses_1", "/repo", 2)

    expect(insertSortedSessionItem([stale, other], fresh)).toEqual([fresh, other])
  })
})
