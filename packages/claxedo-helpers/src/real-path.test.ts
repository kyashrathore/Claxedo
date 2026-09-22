import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { realDirectoryPath } from "./real-path"

describe("realDirectoryPath", () => {
  test("a directory that exists resolves to the name the filesystem uses", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-real-path-"))
    try {
      expect(realDirectoryPath(dir)).toBe(fs.realpathSync.native(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a directory that does not exist resolves lexically", () => {
    const missing = path.join(os.tmpdir(), "claxedo-real-path-absent", "deeper")
    expect(realDirectoryPath(missing)).toBe(path.resolve(missing))
  })
})

/**
 * The 8.3 spelling of the system temp directory, as `cmd` reports it. On a
 * volume with 8.3 creation turned off (`fsutil 8dot3name query C:`) this is the
 * long name, and the case below has nothing to exercise.
 */
function shortTempDirectory() {
  const child = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${os.tmpdir()}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  })
  if (child.status !== 0) throw new Error(`cmd could not spell ${os.tmpdir()} short: ${child.stderr}`)
  return child.stdout.trim()
}

const shortTemp = process.platform === "win32" ? shortTempDirectory() : undefined
const unexercised =
  process.platform !== "win32"
    ? "not win32, and libuv's fs-event assert is Windows-only"
    : realDirectoryPath(shortTemp!) === shortTemp!
      ? "8.3 name creation is off on this volume, so %TEMP% has no short spelling"
      : undefined

/**
 * Node's own libuv aborts the process here, which bun's watcher does not share,
 * so the watch runs in a Node child: an unresolved short directory takes that
 * child down with "Assertion failed: !_wcsnicmp(filename, dir, dirlen)" and
 * exit code 9 instead of reporting the change. Node 24.21.0 floats a libuv
 * fallback, so only a child on an older Node fails without the fix.
 */
describe("watchRealDirectory", () => {
  test.skipIf(unexercised !== undefined)(
    `reports changes in a directory named by its 8.3 spelling${unexercised ? ` — skipped: ${unexercised}` : ""}`,
    () => {
      const directory = fs.mkdtempSync(path.join(shortTemp!, "claxedo-real-path-"))
      try {
        const target = path.join(directory, "watched.md")
        fs.writeFileSync(target, "before")
        const script = path.join(directory, "watch-child.mjs")
        fs.writeFileSync(
          script,
          [
            `import fs from "node:fs"`,
            `import path from "node:path"`,
            `import { watchRealDirectory } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "real-path.ts")).href)}`,
            `const [directory, target] = process.argv.slice(2)`,
            `const watcher = watchRealDirectory(directory, { persistent: false }, (_event, file) => {`,
            `  if (file !== null && file.toString() !== path.basename(target)) return`,
            `  watcher.close()`,
            `  console.log("changed")`,
            `  process.exit(0)`,
            `})`,
            `setTimeout(() => { console.log("no change reported"); process.exit(3) }, 10_000)`,
            `fs.writeFileSync(target, "after")`,
          ].join("\n"),
        )
        const child = spawnSync("node", [script, directory, target], { encoding: "utf8" })
        expect(`${child.status} ${child.stdout.trim()} ${child.stderr.trim()}`).toBe("0 changed")
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
