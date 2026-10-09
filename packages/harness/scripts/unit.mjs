import { spawnSync } from "node:child_process"
import path from "node:path"

const shard = process.env.CLAXEDO_HARNESS_TEST_SHARD?.trim()
if (shard && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
  console.error(`CLAXEDO_HARNESS_TEST_SHARD must be <index>/<count>, got ${shard}`)
  process.exit(1)
}

const root = path.resolve(import.meta.dirname, "..")
const first = !shard || shard.startsWith("1/")

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (first) run("bun", ["run", "check"])
run(process.execPath, ["../../script/test-home/run.mjs", "bun", "test", "src", "scripts", "e2e/harness", ...(shard ? [`--shard=${shard}`] : [])])
if (first) run("bun", ["run", "test:node"])
