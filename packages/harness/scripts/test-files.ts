import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { temporaryHomeEnv } from "../e2e/harness/temporary-home"

const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), "harness-test-home-"))
const result = spawnSync(process.execPath, ["test", ...process.argv.slice(2)], { stdio: "inherit", env: temporaryHomeEnv(home, process.env) })
rmSync(home, { recursive: true, force: true })
process.exit(result.status ?? 1)
