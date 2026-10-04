import { describe, expect, test } from "bun:test"
import { closeSync, mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openServerLogFile, SERVER_LOG_NAME } from "./logging"

describe("embedded server log file", () => {
  test("appends across launches and rolls one generation past 5 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-server-log-"))

    const first = openServerLogFile(dir)
    writeSync(first.fd, "first launch\n")
    closeSync(first.fd)
    const second = openServerLogFile(dir)
    writeSync(second.fd, "second launch\n")
    closeSync(second.fd)
    expect(readFileSync(join(dir, SERVER_LOG_NAME), "utf8")).toBe("first launch\nsecond launch\n")

    writeFileSync(join(dir, SERVER_LOG_NAME), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))
    const third = openServerLogFile(dir)
    writeSync(third.fd, "third launch\n")
    closeSync(third.fd)
    expect(readFileSync(join(dir, SERVER_LOG_NAME), "utf8")).toBe("third launch\n")
    expect(statSync(join(dir, "server.old.log")).size).toBe(5 * 1024 * 1024 + 1)
  })
})
