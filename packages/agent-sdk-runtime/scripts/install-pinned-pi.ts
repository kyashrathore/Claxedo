import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { PI_VERSION } from "../src/harnesses/pi/executable"

/**
 * Installs the pinned Pi under `.artifacts/pi`, outside the workspace graph:
 * it is a 22 MB CLI with its own AWS and Google SDK trees, and adding it to
 * `bun.lock` re-hoists shared packages for every consumer in the repo.
 */
const prefix = path.resolve(import.meta.dirname, "../.artifacts/pi")
fs.mkdirSync(prefix, { recursive: true })
const result = spawnSync(
  "npm",
  ["install", "--prefix", prefix, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${PI_VERSION}`],
  { stdio: "inherit", shell: process.platform === "win32" },
)
process.exit(result.status ?? 1)
