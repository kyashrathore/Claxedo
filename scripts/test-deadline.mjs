#!/usr/bin/env node
// Bounds a package's test command so a silent hang becomes an ATTRIBUTED
// failure. The Windows unit lane wedged runs 367-369 with zero failing
// tests: some task blocked forever, turbo's grouped logging flushes output
// only on completion, and the whole step died at its 35-minute timeout with
// the culprit unidentifiable. Run 371's wrapper kill named the mechanism:
// the victim (sandbox-manager there) produced ZERO bytes in 10 minutes - a
// bun.exe STARTUP wedge, not a test hang - and the victim rotates between
// runs, so every bun-test package runs under this wrapper.
//
// One retry after a deadline kill separates the two failure modes: a
// transient startup wedge passes clean on the second attempt (with both
// loud lines in the log), while a genuine hang gets killed twice and fails
// the task with its name attached.
//
// Usage (from a package.json script): node ../../scripts/test-deadline.mjs bun test src
// Override the budget with CLAXEDO_TEST_DEADLINE_MS.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const cmd = process.argv.slice(2)
// Every wrapped bun-test run gets the win32 event-loop keepalive (a no-op on
// POSIX — see test-keepalive.mjs). CLI --preload MERGES with any bunfig
// [test].preload, verified on 1.3.14, so packages with their own preloads
// keep them.
if (cmd[0] === "bun" && cmd[1] === "test") {
  cmd.splice(2, 0, "--preload", fileURLToPath(new URL("./test-keepalive.mjs", import.meta.url)))
}
const deadlineMs = Number(process.env.CLAXEDO_TEST_DEADLINE_MS ?? 10 * 60 * 1000)

function runOnce(attempt) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" })
    let timedOut = false
    // An unref'd timer still fires while the child keeps the process alive;
    // it just never keeps the wrapper alive after a clean exit.
    const timer = setTimeout(() => {
      timedOut = true
      console.error(
        `\n[test-deadline] ${process.cwd()} exceeded ${deadlineMs}ms (attempt ${attempt}) - killing test process tree ${child.pid}`,
      )
      if (process.platform === "win32" && child.pid) {
        // Windows has no signals and the runner may have children (see
        // agent-sdk-runtime's killHarnessProcess for the same reasoning).
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      } else {
        child.kill("SIGKILL")
      }
      // If even the kill is swallowed, refuse to hang the lane ourselves.
      setTimeout(() => resolve({ timedOut: true, code: 124 }), 15_000).unref()
    }, deadlineMs)
    timer.unref()
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ timedOut, code: code ?? (signal ? 124 : 0) })
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      console.error(`[test-deadline] failed to spawn ${cmd[0]}: ${err.message}`)
      resolve({ timedOut: false, code: 1 })
    })
  })
}

const first = await runOnce(1)
if (!first.timedOut) process.exit(first.code)
console.error(`[test-deadline] retrying once after the deadline kill`)
const second = await runOnce(2)
process.exit(second.timedOut ? 124 : second.code)
