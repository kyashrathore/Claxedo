#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

const kit = join(import.meta.dir, "..")
const ours = new Set(["patches", "UPSTREAM", "script/sync-upstream.ts"])
const untouched = new Set(["node_modules", ".artifacts", ".turbo", "dist"])
const unvendored = (path: string) => /\.stories\.[^/]+$/.test(path) || path.startsWith("src/storybook/")

function run(command: string, args: string[], options: { cwd?: string; input?: Buffer; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? kit, input: options.input, env: options.env, maxBuffer: 1 << 30 })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr.toString()}`)
  }
  return result.stdout
}

function files(root: string, dir = ""): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = dir ? `${dir}/${name}` : name
    if (!dir && untouched.has(name)) return []
    if (ours.has(path)) return []
    return statSync(join(root, path)).isDirectory() ? files(root, path) : [path]
  })
}

function build(commit: string, url: string): { out: string; tree: string } {
  const repo = run("git", ["rev-parse", "--show-toplevel"]).toString().trim()
  const path = relative(repo, kit)
  if (spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: kit }).status !== 0) {
    run("git", ["fetch", "--depth=1", url, commit])
  }
  const out = mkdtempSync(join(tmpdir(), "ui-sync-"))
  run("tar", ["-x", "-C", out], { input: run("git", ["archive", commit, path], { cwd: repo }) })
  const tree = join(out, path)
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(out) }
  const patches = readdirSync(join(kit, "patches")).filter((name) => name.endsWith(".patch")).sort()
  for (const patch of patches) {
    const result = spawnSync("git", ["apply", "--whitespace=nowarn", join(kit, "patches", patch)], { cwd: tree, env })
    if (result.status !== 0) {
      rmSync(out, { recursive: true, force: true })
      throw new Error(`patches/${patch} does not apply to ${commit}:\n${result.stderr.toString()}`)
    }
  }
  for (const path of files(tree)) if (unvendored(path)) rmSync(join(tree, path))
  return { out, tree }
}

function differences(tree: string): string[] {
  const built = new Set(files(tree))
  const current = new Set(files(kit))
  return [...new Set([...built, ...current])].sort().filter((path) => {
    if (!built.has(path) || !current.has(path)) return true
    return !readFileSync(join(tree, path)).equals(readFileSync(join(kit, path)))
  })
}

const [commit, url] = readFileSync(join(kit, "UPSTREAM"), "utf8").trim().split(/\s+/)
if (!commit || !url) throw new Error("UPSTREAM must hold the upstream commit and repository URL")
const { out, tree } = build(commit, url)
const changed = differences(tree)

if (process.argv.includes("--check")) {
  rmSync(out, { recursive: true, force: true })
  if (changed.length === 0) process.exit(0)
  console.error(`packages/ui differs from ${commit.slice(0, 10)} plus patches/:\n${changed.join("\n")}`)
  process.exit(1)
}

for (const path of files(kit)) rmSync(join(kit, path))
for (const path of files(tree)) {
  mkdirSync(dirname(join(kit, path)), { recursive: true })
  cpSync(join(tree, path), join(kit, path))
}
for (const dir of readdirSync(kit)) {
  if (untouched.has(dir) || !statSync(join(kit, dir)).isDirectory()) continue
  pruneEmpty(join(kit, dir))
}
rmSync(out, { recursive: true, force: true })
console.log(`packages/ui = ${commit.slice(0, 10)} + ${readdirSync(join(kit, "patches")).length} patches (${changed.length} files changed)`)

function pruneEmpty(dir: string) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) pruneEmpty(path)
  }
  if (readdirSync(dir).length === 0 && existsSync(dir)) rmSync(dir, { recursive: true })
}
