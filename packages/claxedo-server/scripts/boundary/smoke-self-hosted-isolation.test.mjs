import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "vitest"
import { HARNESS_STATE_ENV } from "../../../workspace-runtime/src/test-support/home/harness-state-env.mjs"

const root = path.resolve(import.meta.dirname, "../..")

test("self-hosted boundary smoke leaves the caller's home empty", async () => {
  const build = spawnSync("bun", ["run", "build:self-hosted-boundary"], { cwd: root, encoding: "utf8" })
  if (build.error) throw build.error
  assert.equal(build.status, 0, `self-hosted boundary build failed:\n${build.stdout}${build.stderr}`)
  const standIn = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "server-smoke-stand-in-home-"))
  try {
    const env = { ...process.env, HOME: standIn, USERPROFILE: standIn }
    for (const name of HARNESS_STATE_ENV) env[name] = path.join(standIn, name)
    const child = spawn(process.execPath, [process.env.CLAXEDO_TEST_SMOKE_SCRIPT ?? "scripts/boundary/smoke-self-hosted.mjs"], {
      cwd: root,
      env,
      stdio: "inherit",
    })
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", resolve)
    })
    assert.equal(code, 0, "self-hosted boundary smoke failed")
    const written = fs.readdirSync(standIn, { recursive: true })
    assert.deepEqual(written, [], `boundary smoke wrote the caller's home: ${written.join(", ")}`)
    console.log("self-hosted boundary smoke left the stand-in home empty")
  } finally {
    fs.rmSync(standIn, { recursive: true, force: true })
  }
}, 60_000)
