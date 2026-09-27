import { test } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"

const exec = promisify(execFile)

test("signed onboarding creates a repository workspace through the real hosted route", async () => {
  const app = path.resolve(import.meta.dirname, "../../..")
  const { stdout } = await exec("bun", [
    "--config=./e2e/bunfig.toml", "src/features/onboarding/test-support/cloud-create-route.ts",
  ], { cwd: app, env: process.env, timeout: 150_000 })
  console.log(stdout.trim())
}, 160_000)
