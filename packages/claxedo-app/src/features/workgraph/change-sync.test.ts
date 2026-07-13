import { describe, expect, test } from "bun:test"
import { ChangeCursorSchema } from "@claxedo/workgraph/contracts"
import { syncWorkGraphChanges } from "./change-sync"
import type { WorkGraphClient } from "./api"

test("ordered changes after the snapshot cursor invalidate and reload the canonical snapshot", async () => {
  const cursors: string[] = []
  let reloads = 0
  const client: Pick<WorkGraphClient, "changes"> = {
    changes: async (cursor) => {
      cursors.push(cursor ?? "")
      return { changes: [{}], cursor: ChangeCursorSchema.parse("1"), timedOut: false } as Awaited<ReturnType<WorkGraphClient["changes"]>>
    },
  }
  expect(await syncWorkGraphChanges(client, ChangeCursorSchema.parse("0"), async () => { reloads++ })).toBe("reloaded")
  expect(cursors).toEqual(["0"])
  expect(reloads).toBe(1)
})
