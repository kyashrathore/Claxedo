/**
 * Ensures native modules are compiled for Node.js's ABI.
 *
 * Bun (the package manager) compiles them for Bun's ABI, which differs
 * from Node.js / Electron. This script detects the mismatch and rebuilds
 * only when necessary, so it's fast on normal runs (~50ms).
 *
 * Uses node-gyp directly (clean → configure → build) instead of npm rebuild,
 * because npm rebuild reuses stale Bun build artifacts and fails.
 */
import { execSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname } from "node:path"

const require = createRequire(import.meta.url)

try {
  const Database = require("better-sqlite3")
  const db = new Database(":memory:")
  db.close()
} catch (e) {
  if (e.code === "ERR_DLOPEN_FAILED" || e.message?.includes("Could not locate the bindings file")) {
    console.log("[ensure-native] better-sqlite3 native module not usable, rebuilding for Node.js...")
    const pkgDir = dirname(require.resolve("better-sqlite3/package.json"))
    execSync("npx node-gyp clean && npx node-gyp configure && npx node-gyp build --release", {
      cwd: pkgDir,
      stdio: "inherit",
    })
    console.log("[ensure-native] done.")
  } else {
    throw e
  }
}
