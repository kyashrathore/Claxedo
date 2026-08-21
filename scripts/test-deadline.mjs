#!/usr/bin/env node
// Bounds a package's test command so a silent hang becomes an ATTRIBUTED
// failure. The Windows unit lane wedged three runs straight (367-369) with
// zero failing tests: some task blocks forever, turbo's grouped logging
// flushes output only on completion, and the whole step dies at its
// 35-minute timeout with the culprit unidentifiable. Wrapping a suspect
// suite in this deadline turns that into "<package> exceeded the deadline"
// after 10 minutes - naming the hang and saving the other 25.
//
// Usage (from a package.json script): node ../../scripts/test-deadline.mjs bun test src
// Override the budget with CLAXEDO_TEST_DEADLINE_MS.
import { spawn } from "node:child_process"

const cmd = process.argv.slice(2)
const deadlineMs = Number(process.env.CLAXEDO_TEST_DEADLINE_MS ?? 10 * 60 * 1000)
const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" })

// An unref'd timer still fires while the child keeps the process alive; it
// just never keeps the wrapper alive after a clean exit.
const timer = setTimeout(() => {
  console.error(`\n[test-deadline] ${process.cwd()} exceeded ${deadlineMs}ms - killing test process tree ${child.pid}`)
  if (process.platform === "win32" && child.pid) {
    // Windows has no signals and the runner may have children (see
    // agent-sdk-runtime's killHarnessProcess for the same reasoning).
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    child.kill("SIGKILL")
  }
  // If even the kill is swallowed, refuse to hang the lane ourselves.
  setTimeout(() => process.exit(124), 15_000).unref()
}, deadlineMs)
timer.unref()

child.on("exit", (code, signal) => {
  clearTimeout(timer)
  process.exit(code ?? (signal ? 124 : 0))
})
child.on("error", (err) => {
  console.error(`[test-deadline] failed to spawn ${cmd[0]}: ${err.message}`)
  process.exit(1)
})
