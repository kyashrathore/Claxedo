import { spawnSync } from "node:child_process"
import path from "node:path"

// CI splits this suite across runners because `fileParallelism: false` keeps
// its files serial: 22 minutes on a 2-core Linux runner, past 35 on Windows.
// The shard arrives by environment because turbo appends CLI arguments to the
// end of the script, where they would reach the Worker suite instead.
const shard = process.env.CLAXEDO_SERVER_TEST_SHARD?.trim()
if (shard && !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
  console.error(`CLAXEDO_SERVER_TEST_SHARD must be <index>/<count>, got ${shard}`)
  process.exit(1)
}

const root = path.resolve(import.meta.dirname, "../..")

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, [
  "./node_modules/vitest/vitest.mjs",
  "run",
  "--reporter=default",
  "--reporter=junit",
  "--outputFile.junit=.artifacts/unit/junit.xml",
  ...(shard ? [`--shard=${shard}`] : []),
])
if (!shard || shard.startsWith("1/")) {
  run("bun", ["run", "test"], path.join(root, "scripts/sandbox/cloudflare-worker"))
}
