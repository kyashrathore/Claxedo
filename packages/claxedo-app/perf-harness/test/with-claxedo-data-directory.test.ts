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
    try {
      await Promise.all([
        withClaxedoDataDirectory(first, async () => {
          order.push("first:start")
          await Bun.sleep(10)
          ClaxedoDB.raw().exec("CREATE TABLE materializer_owner (value TEXT NOT NULL); INSERT INTO materializer_owner VALUES ('first')")
          order.push("first:end")
        }),
        withClaxedoDataDirectory(second, async () => {
          order.push("second:start")
          ClaxedoDB.raw().exec("CREATE TABLE materializer_owner (value TEXT NOT NULL); INSERT INTO materializer_owner VALUES ('second')")
          order.push("second:end")
        }),
      ])

      expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
      expect(process.env.CLAXEDO_DATA_DIR).toBe(previous)
      expect(readOwner(first)).toBe("first")
      expect(readOwner(second)).toBe("second")
    } finally {
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
