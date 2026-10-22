import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { asRecordOrEmpty, nonEmptyString } from "@claxedo/helpers/guards"
import { CLAXEDO_MIGRATION_JOURNAL } from "@claxedo/server-core/platform/db/journal"

const ROOT = path.resolve(import.meta.dirname, "..")
const manifest = asRecordOrEmpty(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")))
const version = nonEmptyString(manifest.version)
const binPath = nonEmptyString(asRecordOrEmpty(manifest.bin).claxedo)
if (!version || !binPath) throw new Error("package.json must declare a version and the claxedo bin")
const bin = path.join(ROOT, binPath)
const failures: string[] = []

// The bin runs under the `node` on PATH, as npm links it; this script itself runs under Bun.
const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim()
if (Number(nodeVersion.replace(/^v/, "").split(".")[0]) < 24) failures.push(`claxedo needs Node.js 24+ on PATH, found ${nodeVersion || "none"}`)

// `claxedo connect` refuses every workspace when the journal beside the bundle is missing or partial.
const migrations = (dir: string) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, "migration.sql"))).sort() : []
const shipped = migrations(path.join(ROOT, "dist", "claxedo-migration"))
const canonical = migrations(CLAXEDO_MIGRATION_JOURNAL)
if (canonical.length === 0 || shipped.join("\n") !== canonical.join("\n")) {
  failures.push(`dist/claxedo-migration holds ${shipped.length} migrations, the journal ${canonical.length}`)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cli-verify-"))
function claxedo(...args: string[]) {
  const result = spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAXEDO_HOME: path.join(home, ".claxedo") },
  })
  if (result.status !== 0) failures.push(`claxedo ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

try {
  if (failures.length === 0) {
    const printed = claxedo("--version")
    if (printed !== version) failures.push(`claxedo --version printed ${printed}, expected ${version}`)
    if (!claxedo("--help").includes("claxedo connect")) failures.push("claxedo --help does not list connect")
    if (!claxedo("connect", "--help").includes("--token-file")) failures.push("claxedo connect --help does not document --token-file")
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error("Publish verification failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`Publish verification passed: claxedo ${version} starts on Node ${nodeVersion} with ${shipped.length} migrations`)
