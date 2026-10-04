import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expectedOwnerOnlyDescription, inheritablyWidenWindowsDirectory, ownerOnlyDescription } from "./private-file.test-support"

/**
 * The shipped CLI runs Node, not Bun: `packages/cli/package.json` requires
 * `node >= 24` and its build bundles for that platform. Everything else in this
 * package is exercised by `bun test`, which resolves `@claxedo/helpers/fs` to
 * the TypeScript source and opens files through Bun's own share masks — libuv's
 * differ. So the built entrypoint is run once under real Node here, against the
 * same properties, or the lane would be proving a runtime nobody ships.
 */

const demanded = process.env.CLAXEDO_WINDOWS_ACL_ACCEPTANCE === "1"
const SECRET = '{"accessToken":"tok_do_not_share"}'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claxedo-node-private-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function node() {
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["node"], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : undefined
}

const built = join(import.meta.dirname, "..", "dist", "fs.mjs")

describe("the built writer under the runtime the CLI ships", () => {
  test("writes a private file that Node itself can read back", () => {
    const executable = node()
    if (!executable || !existsSync(built)) {
      const detail = !executable ? "node is not on PATH" : "the package has not been built"
      if (demanded) throw new Error(`CLAXEDO_WINDOWS_ACL_ACCEPTANCE demanded the Node run but ${detail}`)
      return
    }
    if (process.platform === "win32") inheritablyWidenWindowsDirectory(dir)

    const target = join(dir, "credentials.json")
    const script = join(dir, "run.mjs")
    // The secret is written by the script, so it never appears in an argument
    // list or an environment any other process can read.
    writeFileSync(
      script,
      [
        `import { writePrivateFileAtomic } from ${JSON.stringify(pathToFileURL(built).href)}`,
        `await writePrivateFileAtomic(${JSON.stringify(target)}, ${JSON.stringify(SECRET)})`,
        `process.stdout.write("done")`,
      ].join("\n"),
    )

    const result = execFileSync(executable, [script], { encoding: "utf8" })

    expect(result).toBe("done")
    expect(readFileSync(target, "utf8")).toBe(SECRET)
    expect(ownerOnlyDescription(target)).toBe(expectedOwnerOnlyDescription())
    expect(readdirSync(dir).sort()).toEqual(["credentials.json", "run.mjs"])
  })
})
