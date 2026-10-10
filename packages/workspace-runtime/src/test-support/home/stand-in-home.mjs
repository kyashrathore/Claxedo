import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HOME_STATE_ENV } from "../../../../../script/test-home/temporary-home.mjs"

function run(command, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), options)
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk.toString() })
    child.stderr.on("data", (chunk) => { output += chunk.toString() })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })
}

/**
 * Runs `command` from `packageDir` the way a developer starts it: HOME, and
 * every name that relocates a harness's or Claxedo's state, point at a
 * stand-in for their real home. `written` is everything that landed there.
 */
export async function runUnderStandInHome(packageDir, command) {
  const standIn = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "stand-in-home-"))
  try {
    const env = { ...process.env, HOME: standIn, USERPROFILE: standIn }
    for (const key of HOME_STATE_ENV) env[key] = path.join(standIn, key)
    // Bun places its transpiler cache under XDG_CACHE_HOME at startup, before
    // any preload runs; that cache is Bun's, not a harness's.
    env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"
    const child = await run(command, { cwd: packageDir, env })
    return { ...child, written: fs.readdirSync(standIn, { recursive: true }) }
  } finally {
    fs.rmSync(standIn, { recursive: true, force: true })
  }
}
