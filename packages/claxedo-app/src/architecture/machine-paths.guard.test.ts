import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * GUARD: no source, test, script, or config in this package names a path that
 * exists only on one developer's machine.
 *
 * Seven scripts once carried `/Users/<name>/test/opencode` as their working
 * directory, and five tests carried it as fixture data. Such a file runs for
 * exactly one person, fails opaquely for everyone else, and tells an agent
 * that reads it nothing about where the repository actually is. The scanner
 * runs over everything this package tracks except build output and dependency
 * trees, so a new one fails here rather than on a stranger's laptop.
 *
 * Synthetic homes in fixtures (`/home/demo/projects/my-app`, `/Users/host/opencode`)
 * are product-shaped data and stay allowed. What is refused is a path only this
 * machine can resolve: the running user's own home directory and an agent
 * session's scratch root. The check is local by design — the pre-push hook runs
 * it on the author's machine, which is the only place the author's home path
 * can be recognised.
 */

const appRoot = path.resolve(import.meta.dir, "../..")
const SKIP_DIRS = new Set(["node_modules", "dist", ".artifacts", "test-results", "evidence", "reports", "data"])
const SKIP_PREFIXES = ["dist-"]
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".toml", ".yml", ".yaml", ".sh"])

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A path that can only resolve on this machine. */
export function machinePathPattern(home = os.homedir()) {
  // Built by concatenation so this file's own source never contains the literals it forbids.
  const scratch = ["/private/tmp/", "claude-"].join("")
  const scratchTmp = ["/tmp/", "claude-", String.raw`\d+/`].join("")
  return new RegExp([escape(`${home.replace(/\/+$/, "")}/`), escape(scratch), scratchTmp].join("|"))
}

const MACHINE_PATH = machinePathPattern()

export function machinePathOffenders(root: string): string[] {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || SKIP_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!TEXT_EXTENSIONS.has(path.extname(entry))) continue
      const text = readFileSync(full, "utf8")
      const lines = text.split("\n")
      lines.forEach((line, index) => {
        if (MACHINE_PATH.test(line)) offenders.push(`${path.relative(root, full)}:${index + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
  }
  walk(root)
  return offenders.toSorted()
}

describe("machine-specific paths", () => {
  test("no tracked text file in this package names a home directory or a session scratch root", () => {
    expect(machinePathOffenders(appRoot)).toEqual([])
  })

  test("the pattern catches the shapes that shipped, and nothing portable", () => {
    const pattern = machinePathPattern("/Users/dev")
    const scratch = ["/private/tmp/", "claude-501/-Users-x/abc/scratchpad/data"].join("")
    const scratchTmp = ["/tmp/", "claude-501/session/out"].join("")
    for (const bad of [
      'const ROOT = "/Users/dev/test/opencode/packages/claxedo-app"',
      'initialCommand: "/Users/dev/.claxedo/bin/claude"',
      `CLAXEDO_DATA_DIR=${scratch}`,
      `const out = \`${scratchTmp}\``,
    ]) {
      expect(pattern.test(bad), bad).toBe(true)
    }
    for (const fine of [
      'directory: "/srv/repos/opencode"',
      '"cwd": "/home/demo/projects/my-app"',
      'const HOST_PATH = "/Users/host/opencode"',
      'worktree: "/Users/me/test/opencode"',
      "path.join(os.tmpdir(), `claxedo-${Date.now()}`)",
      "const home = os.homedir()",
      '"/workspaces/ws_signed_browser_relay/session"',
    ]) {
      expect(pattern.test(fine), fine).toBe(false)
    }
  })
})
