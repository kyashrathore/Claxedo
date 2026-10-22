import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")

function packageManifests() {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "packages/*/package.json"], { cwd: root })
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`)
  return listed.stdout.toString().split("\0").filter(Boolean)
}

/** The scripts a package's `test` runs, itself included, following `bun run <name>` and `npm run <name>`. */
function testChain(scripts: Record<string, string>) {
  const chain = new Map<string, string>()
  const visit = (name: string) => {
    const command = scripts[name]
    if (command === undefined || chain.has(name)) return
    chain.set(name, command)
    for (const match of command.matchAll(/\b(?:bun|npm) run ([\w:-]+)/g)) if (match[1]) visit(match[1])
  }
  visit("test")
  return chain
}

/**
 * CI builds every dist a suite imports once, before any suite runs, and then
 * runs the suites side by side. A suite that rebuilds its own package deletes
 * that package's dist for the length of the build, and another package's suite
 * loading from it then fails with "Cannot find module …/dist/…".
 */
test("no package's test runs that package's build", () => {
  const rebuilding = packageManifests().flatMap((manifest) => {
    const scripts: Record<string, string> = JSON.parse(readFileSync(path.join(root, manifest), "utf8")).scripts ?? {}
    return [...testChain(scripts)].filter(([name]) => name === "build").map(() => path.dirname(manifest))
  })
  expect(rebuilding).toEqual([])
})
