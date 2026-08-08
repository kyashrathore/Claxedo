#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const warningFlag = "--disable-warning=ExperimentalWarning"

if (!process.execArgv.includes(warningFlag)) {
  const result = spawnSync(process.execPath, [warningFlag, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
  })
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

const { main } = await import("../src/cli.js")

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
