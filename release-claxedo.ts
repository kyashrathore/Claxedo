#!/usr/bin/env bun

import path from "node:path"

import { inc, rcompare, valid } from "semver"

const root = import.meta.dir
const repo = "kyashrathore/opencode"
const args = Bun.argv.slice(2)
const bump = args.find((arg) => ["major", "minor", "patch"].includes(arg)) ?? "patch"
const dry = args.includes("--dry-run")
const sync = args.includes("--sync")
const noCommit = args.includes("--no-commit")
const noTag = args.includes("--no-tag") || noCommit
const dispatch = args.includes("--dispatch")
const plats = flag("platforms") ?? "all"

const appFile = path.join(root, "packages/claxedo-app/package.json")
const deskFile = path.join(root, "packages/claxedo-desktop/package.json")
const logFile = path.join(root, "packages/claxedo-app/CHANGELOG.md")
const flow = "release-claxedo.yml"

if (!["major", "minor", "patch"].includes(bump)) {
  fail("usage: bun ./release-claxedo.ts [major|minor|patch] [--sync] [--dry-run] [--no-commit] [--no-tag] [--dispatch] [--platforms all|macos|windows|linux]")
}

if (!["all", "macos", "windows", "linux"].includes(plats)) {
  fail(`unsupported platforms value: ${plats}`)
}

const last = latest()
const next = inc(last.version, bump)
if (!next) fail(`could not bump ${last.version}`)

const app = await json(appFile)
const desk = await json(deskFile)
const log = await Bun.file(logFile).text()
const state = changelog(log)

const bad = [
  ...(app.version === last.version ? [] : [`packages/claxedo-app/package.json is ${app.version}`]),
  ...(desk.version === last.version ? [] : [`packages/claxedo-desktop/package.json is ${desk.version}`]),
  ...(state.base === last.version ? [] : [`packages/claxedo-app/CHANGELOG.md [Unreleased] points at ${state.base ?? "nothing"}`]),
  ...(state.head && state.head !== last.version ? [`packages/claxedo-app/CHANGELOG.md latest section is ${state.head}`] : []),
]

if (bad.length && !sync) {
  fail(`release metadata does not match ${last.tag}:\n- ${bad.join("\n- ")}\nrerun with --sync to treat ${last.tag} as canonical`)
}

if (bad.length) {
  console.log(`[release] syncing from ${last.tag}`)
  for (const line of bad) console.log(`[release] ${line}`)
}

console.log(`[release] latest release tag: ${last.tag}`)
console.log(`[release] next version: ${next}`)

if (dry) {
  printPlan(next)
  process.exit(0)
}

app.version = next
desk.version = next

await Bun.write(appFile, `${JSON.stringify(app, null, 2)}\n`)
await Bun.write(deskFile, `${JSON.stringify(desk, null, 2)}\n`)
await Bun.write(logFile, bumpLog(log, last.version, next))

console.log("[release] updated package versions and changelog")

if (!noCommit) {
  run(["git", "add", appFile, deskFile, logFile])
  run(["git", "commit", "-m", `chore(claxedo): release v${next}`])
  console.log(`[release] committed release v${next}`)
}

if (!noTag) {
  run(["git", "tag", "-a", `claxedo-v${next}`, "-m", `Claxedo v${next}`])
  console.log(`[release] tagged claxedo-v${next}`)
}

if (dispatch) {
  run(["gh", "workflow", "run", flow, "-f", `version=${next}`, "-f", `platforms=${plats}`])
  console.log(`[release] dispatched ${flow} for ${next}`)
}

printPlan(next)

function printPlan(next: string) {
  const branch = run(["git", "branch", "--show-current"], true).trim() || "HEAD"

  if (noCommit) {
    console.log("[release] release files updated locally; commit skipped")
  } else if (noTag) {
    console.log(`[release] push with: git push origin ${branch}`)
  } else {
    console.log(`[release] push with: git push origin ${branch} && git push origin claxedo-v${next}`)
  }

  if (!dispatch) {
    console.log(`[release] tag push will trigger ${flow}`)
  }
}

function flag(name: string) {
  const key = `--${name}`
  const pair = `--${name}=`
  const hit = args.find((arg) => arg.startsWith(pair))
  if (hit) return hit.slice(pair.length)
  const ix = args.indexOf(key)
  if (ix === -1) return
  return args[ix + 1]
}

function fail(msg: string): never {
  console.error(`[release] ${msg}`)
  process.exit(1)
}

function run(cmd: string[], soft = false) {
  const proc = Bun.spawnSync({
    cmd,
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = proc.stdout.toString().trim()
  const err = proc.stderr.toString().trim()
  if (!soft && proc.exitCode !== 0) {
    fail(`${cmd.join(" ")} failed${err ? `\n${err}` : ""}`)
  }
  return out
}

function latest() {
  const seen = new Set<string>()
  const tags = [
    ...parse(run(["git", "tag", "--list", "claxedo-v*"], true)),
    ...parse(run(["git", "ls-remote", "--tags", "origin", "claxedo-v*"], true)),
  ].filter((tag) => {
    if (seen.has(tag)) return false
    seen.add(tag)
    return true
  })

  const good = tags
    .map((tag) => ({ tag, version: tag.slice("claxedo-v".length), note: note(tag) }))
    .filter((item) => valid(item.version) && looksReleased(item.note, item.version))
    .sort((a, b) => rcompare(a.version, b.version))

  if (good.length === 0) {
    fail("no canonical claxedo release tags found")
  }

  return good[0]
}

function parse(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const ref = line.includes("refs/tags/") ? line.split("refs/tags/")[1] : line
      return ref.replace(/\^\{\}$/, "")
    })
    .filter((line) => line.startsWith("claxedo-v"))
}

function note(tag: string) {
  return run(["git", "tag", "-n99", "--list", tag], true)
    .replace(`${tag} `, "")
    .trim()
}

function looksReleased(note: string, version: string) {
  return note === `Claxedo v${version}` ||
    note === `Claxedo App v${version}` ||
    note.includes(`release v${version}`)
}

async function json(file: string) {
  return await Bun.file(file).json() as Record<string, unknown> & { version: string }
}

function changelog(text: string) {
  const base = text.match(/^\[Unreleased\]: .*claxedo-v(\d+\.\d+\.\d+)\.\.\.HEAD$/m)?.[1]
  const head = text.match(/^## \[(\d+\.\d+\.\d+)\] - /m)?.[1]
  return { base, head }
}

function bumpLog(text: string, prev: string, next: string) {
  const date = new Date().toISOString().slice(0, 10)
  const head = "## [Unreleased]"
  if (!text.includes(head)) fail("packages/claxedo-app/CHANGELOG.md is missing the Unreleased header")

  let out = text.replace(head, `${head}\n\n## [${next}] - ${date}\n\n### Added\n\n### Changed\n\n### Fixed\n`)
  const unreleased = `[Unreleased]: https://github.com/${repo}/compare/claxedo-v${next}...HEAD`
  const link = `[${next}]: https://github.com/${repo}/compare/claxedo-v${prev}...claxedo-v${next}`

  if (/^\[Unreleased\]:.*$/m.test(out)) {
    out = out.replace(/^\[Unreleased\]:.*$/m, `${unreleased}\n${link}`)
  } else {
    out = `${out.trimEnd()}\n\n${unreleased}\n${link}\n`
  }

  return `${out.trimEnd()}\n`
}
