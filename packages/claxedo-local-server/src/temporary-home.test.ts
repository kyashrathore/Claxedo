import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, test } from "vitest"

test("vitest runs these tests in a temporary home, not the developer's", () => {
  expect(os.homedir().startsWith(realpathSync.native(os.tmpdir()) + path.sep)).toBe(true)
})
