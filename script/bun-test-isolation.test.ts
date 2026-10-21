import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

function trackedFiles() {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "packages"], { cwd: root })
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  return listed.stdout.toString().split("\0").filter(Boolean)
}

function packagesMockingModules() {
  const owners = new Set<string>()
  for (const file of trackedFiles()) {
    if (!/\.test\.[cm]?tsx?$/.test(file)) continue
    if (readFileSync(path.join(root, file), "utf8").includes("mock.module(")) owners.add(file.split("/").slice(0, 2).join("/"))
  }
  return [...owners].sort()
}

/**
 * Bun runs every file of one `bun test` in a single module registry unless it
 * is told to isolate them, so a `mock.module` stand-in stays in place for the
 * files after it. A stand-in that lacks an export a later file's imports need
 * fails that file with "Export named … not found", and only in the file orders
 * where the later file follows; Linux and macOS list directories in different
 * orders.
 */
test("every package whose bun tests replace a module runs each bun test invocation with --isolate", () => {
  const owners = packagesMockingModules()
  expect(owners).toContain("packages/claxedo-app")
  const unisolated = owners.flatMap((owner) => {
    const scripts: Record<string, string> = JSON.parse(readFileSync(path.join(root, owner, "package.json"), "utf8")).scripts ?? {}
    const runs = Object.entries(scripts).flatMap(([name, command]) =>
      [...command.matchAll(/\bbun test\b[^&|;]*/g)].map((match) => ({ name, invocation: match[0] })))
    if (runs.length === 0) return [`${owner}: no package script runs bun test`]
    return runs.filter((run) => !/\s--(?:isolate|parallel)\b/.test(run.invocation)).map((run) => `${owner} ${run.name}: ${run.invocation.slice(0, 80)}`)
  })
  expect(unisolated).toEqual([])
})
