import { expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

test("bun runs these tests in a temporary home, not the developer's", () => {
  expect(os.homedir().startsWith(realpathSync.native(os.tmpdir()) + path.sep)).toBe(true)
})
