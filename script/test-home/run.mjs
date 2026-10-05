import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { temporaryHomeEnv } from "./temporary-home.mjs"

const [command, ...args] = process.argv.slice(2)
const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), "claxedo-test-home-"))
const result = spawnSync(command, args, { stdio: "inherit", env: temporaryHomeEnv(home, process.env) })
rmSync(home, { recursive: true, force: true, maxRetries: 10 })
if (result.error) throw result.error
process.exit(result.status ?? 1)
