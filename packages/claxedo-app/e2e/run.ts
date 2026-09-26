import { spawn } from "node:child_process"
import path from "node:path"

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..")
const PLAYWRIGHT = path.join(PACKAGE_ROOT, "node_modules/.bin/playwright")

const child = spawn(PLAYWRIGHT, ["test", "--config", "playwright.config.ts", ...process.argv.slice(2)], {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
})
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
