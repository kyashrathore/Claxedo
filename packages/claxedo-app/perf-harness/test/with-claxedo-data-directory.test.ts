import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { withClaxedoDataDirectory } from "../src/with-claxedo-data-directory"

describe("disposable Claxedo data-directory scope", () => {
  test("serializes process-global selections and opens each database independently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-data-scope-"))
    const first = path.join(root, "first")
    const second = path.join(root, "second")
    const previous = process.env.CLAXEDO_DATA_DIR
    const order: string[] = []
    const ClaxedoDB = await claxedoDatabase()
    let releaseFirst!: () => void
    const released = new Promise<void>((resolve) => { releaseFirst = resolve })
    let enterFirst!: () => void
    const entered = new Promise<void>((resolve) => { enterFirst = resolve })
    let operations: Promise<void>[] = []
    try {
      operations = [
        withClaxedoDataDirectory(first, async () => {
          order.push("first:start")
          enterFirst()
          await released
          ClaxedoDB.raw().exec("CREATE TABLE materializer_owner (value TEXT NOT NULL); INSERT INTO materializer_owner VALUES ('first')")
          order.push("first:end")
        }),
        withClaxedoDataDirectory(second, async () => {
          order.push("second:start")
          ClaxedoDB.raw().exec("CREATE TABLE materializer_owner (value TEXT NOT NULL); INSERT INTO materializer_owner VALUES ('second')")
          order.push("second:end")
        }),
      ]
      await entered
      expect(order).toEqual(["first:start"])
      expect(process.env.CLAXEDO_DATA_DIR).toBe(first)
      releaseFirst()
      await Promise.all(operations)

      expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
      expect(process.env.CLAXEDO_DATA_DIR).toBe(previous)
      expect(readOwner(first)).toBe("first")
      expect(readOwner(second)).toBe("second")
    } finally {
      releaseFirst()
      await Promise.allSettled(operations)
      ClaxedoDB.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function claxedoDatabase() {
  const databaseModule = "../../../claxedo-server-core/src/platform/db/index.ts"
  return (
    (await import(databaseModule)) as {
      ClaxedoDB: {
        close(): void
        raw(): { exec(sql: string): unknown }
      }
    }
  ).ClaxedoDB
}

function readOwner(directory: string) {
  const database = new Database(path.join(directory, "claxedo.db"), { readonly: true })
  try {
    return (database.query("SELECT value FROM materializer_owner").get() as { value: string }).value
  } finally {
    database.close()
  }
}
