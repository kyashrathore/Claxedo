import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { PORT_RANGE } from "./ports"

const [name, mode = "compare"] = process.argv.slice(2)
if (!name || !/^(?:record|compare)$/.test(mode) || process.argv.length > 4) {
  throw new Error("Usage: bun run --cwd packages/harness corpus <flow> [record|compare]")
}
if (name === "all") {
  const base = path.resolve(import.meta.dirname, "../")
  const red = JSON.parse(readFileSync(path.join(base, "flows/expected-red.json"), "utf8")) as Record<string, string[]>
  const excluded = JSON.parse(readFileSync(path.join(base, "corpus/excluded.json"), "utf8")) as Record<string, string>
  const flows = readdirSync(path.join(base, "flows"))
    .filter((file) => /^H\d+[a-z]?(?:\.[a-z0-9]+)?-.*\.flow\.ts$/.test(file))
    .map((file) => file.slice(0, -".flow.ts".length))
    .filter((flow) => !(flow.slice(0, flow.indexOf("-")) in red))
    .sort()
  let failures = 0
  for (const [index, flow] of flows.entries()) {
    const file = path.join(base, "corpus", `${flow}.json`)
    if (mode === "compare" && !existsSync(file)) {
      console.error(`Missing wire corpus for ${flow}`)
      failures++
      continue
    }
    if (mode === "compare" && flow in excluded) {
      console.log(`Excluded ${flow}: ${excluded[flow]}`)
      continue
    }
    const daemonPort = PORT_RANGE.first + index % (PORT_RANGE.last - PORT_RANGE.first + 1)
    const env = { ...process.env, CLAXEDO_E2E_DAEMON_PORT: process.env.CLAXEDO_E2E_DAEMON_PORT ?? String(daemonPort) }
    const result = spawnSync(process.execPath, [import.meta.path, flow, mode], { stdio: "inherit", env })
    if (result.error) throw result.error
    if (result.status !== 0) failures++
  }
  if (failures) process.exitCode = 1
  else console.log(`Wire corpus ${mode} completed for ${flows.length} passing flows (${Object.keys(excluded).length} excluded from compare)`)
} else {
  process.env.CLAXEDO_E2E_CORPUS = mode
  process.argv.splice(3)
  await import("./run-corpus-flow")
}
