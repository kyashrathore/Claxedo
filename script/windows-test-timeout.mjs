#!/usr/bin/env node
// Runs `bun test` with a 20 s per-test default on win32 and unchanged elsewhere.
//
// On the hosted Windows runner a test's first private-file write starts a
// PowerShell runner (1.4 to 5.3 s), `removeTempRoot` waits up to 10 s for a
// closed temp root's handles, and opening a fresh SQLite store has stalled for
// 4.9 s; bun's 5 s default fails on any of them.
//
// The budget travels as `--timeout` because bun 1.3.14 resets a
// `setDefaultTimeout` override after each test file (`runAllTests` in
// test_command.zig), so a preload's default covered only the first file of a
// run while later files, hooks included, fell back to 5 s.
//
// Usage (from a package.json script): node ../../script/windows-test-timeout.mjs bun test src
import { spawnSync } from "node:child_process"

const WINDOWS_TEST_TIMEOUT_MS = 20_000

const command = process.argv.slice(2)
if (command[0] !== "bun" || command[1] !== "test") {
  console.error("usage: node windows-test-timeout.mjs bun test [args...]")
  process.exit(2)
}
if (process.platform === "win32") command.splice(2, 0, `--timeout=${WINDOWS_TEST_TIMEOUT_MS}`)
const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" })
if (result.error) throw result.error
process.exit(result.status ?? 1)
