import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, test } from "vitest"
import {
  createSqliteWorkGraphActivityPorts,
  createSqliteWorkGraphService,
} from "../../src"
import { workGraphActivityConformance } from "../../src/conformance"
import type { OperationID, StreamID, WorkItemID } from "../../src/contracts"

const databases: BetterSqlite3.Database[] = []

afterEach(() => databases.splice(0).forEach((database) => database.close()))

describe("SQLite WorkGraph activity conformance v1", () => {
  for (const conformance of workGraphActivityConformance(async () => {
    const database = new BetterSqlite3(":memory:")
    databases.push(database)
    let id = 0
    let seed = 0
    const clock = { now: () => 1_000 }
    const ids = { next: (kind: string) => `${kind}_${++id}` }
    const service = createSqliteWorkGraphService({ database, clock, ids }).service
    const ports = () => createSqliteWorkGraphActivityPorts({ database, clock, ids })
    const initial = ports()
    return {
      ...initial,
      snapshot: (context, input) => service.query(context, "snapshot", "page", input),
      seed: async (context) => {
        const suffix = ++seed
        const stream = await service.execute(context, {
          operationId: `activity_conformance_stream_${suffix}` as OperationID,
          command: { version: 1, type: "create_stream", title: `Activity ${suffix}` },
        })
        const streamId = resultId(stream, "streamId") as StreamID
        const item = await service.execute(context, {
          operationId: `activity_conformance_item_${suffix}` as OperationID,
          command: {
            version: 1,
            type: "create_work_item",
            streamId,
            title: `Task ${suffix}`,
            completionContract: {
              version: 1,
              mode: "all",
              requirements: [{ id: `proof_${suffix}` as never, kind: "test", description: "Prove activity" }],
            },
          },
        })
        return { streamId, workItemId: resultId(item, "workItemId") as WorkItemID }
      },
      restart: async () => ports(),
    }
  })) test(conformance.name, conformance.run)
})

function resultId(result: { ok: boolean; value?: unknown }, key: string) {
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value) ||
    typeof (result.value as Record<string, unknown>)[key] !== "string") {
    throw new Error(`Expected ${key}`)
  }
  return (result.value as Record<string, string>)[key]!
}
