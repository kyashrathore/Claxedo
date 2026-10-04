import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HARNESS_STATE_ENV } from "@claxedo/session-core/testing"

function run(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options)
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk.toString() })
    child.stderr.on("data", (chunk) => { output += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })
}

/**
 * Runs `bun test` on `files` from `packageDir` the way a developer starts it:
 * HOME, and every name that relocates a harness's state, point at a stand-in
 * for their real home, so only the package's preload stands between what the
 * tests write and that stand-in. `written` is everything that landed there.
 */
export async function runUnderStandInHome(packageDir, files) {
  // `bun test` with no files runs the whole suite, the calling guard included.
  if (files.length === 0) throw new Error("no test files to run under a stand-in home")
  const standIn = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "stand-in-home-"))
  try {
    const env = { ...process.env, HOME: standIn, USERPROFILE: standIn }
    for (const key of HARNESS_STATE_ENV) env[key] = path.join(standIn, key)
    // Bun places its transpiler cache under XDG_CACHE_HOME at startup, before
    // any preload runs; that cache is Bun's, not a harness's.
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"
    const child = await run(process.execPath, ["test", ...files], { cwd: packageDir, env })
    return { ...child, written: fs.readdirSync(standIn, { recursive: true }) }
  } finally {
    fs.rmSync(standIn, { recursive: true, force: true })
  }
}
