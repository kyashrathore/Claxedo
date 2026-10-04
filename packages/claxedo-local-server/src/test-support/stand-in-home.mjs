import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { HARNESS_STATE_ENV } from "@claxedo/session-core/testing"

const packageDir = path.resolve(import.meta.dirname, "../..")
const standIn = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "local-server-stand-in-home-"))

try {
  const env = { ...process.env, HOME: standIn, USERPROFILE: standIn }
  for (const name of HARNESS_STATE_ENV) env[name] = path.join(standIn, name)
  const child = spawn(process.execPath, ["./node_modules/vitest/vitest.mjs", "run", "src/agent-plugins", "--config", process.argv[2] ?? "vitest.config.ts", ...process.argv.slice(3)], {
    cwd: packageDir,
    env,
    stdio: "inherit",
  })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  assert.equal(code, 0, "agent-plugins Vitest suite failed")
  const written = fs.readdirSync(standIn, { recursive: true })
  assert.deepEqual(written, [], `agent-plugins suite wrote the caller's home: ${written.join(", ")}`)
  console.log("agent-plugins left the stand-in home empty")
} finally {
  fs.rmSync(standIn, { recursive: true, force: true })
}
