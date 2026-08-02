import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"
import { WORKER_SCHEDULED_DISPATCH } from "./worker"

describe("Worker cron registration", () => {
  test("production and staging register exactly the live scheduled branches", async () => {
    const config = await readFile(new URL("../../../wrangler.toml", import.meta.url), "utf8")
    const registered = [...config.matchAll(/^crons\s*=\s*(\[[^\n]+\])$/gm)]
      .map((match) => JSON.parse(match[1]!) as string[])
    const expected = Object.keys(WORKER_SCHEDULED_DISPATCH).sort()

    expect(registered).toHaveLength(2)
    expect(registered.map((crons) => crons.toSorted())).toEqual([expected, expected])
  })
})
