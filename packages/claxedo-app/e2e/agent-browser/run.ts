/**
 * Runner: ensure Chromium is installed, then execute the agent-browser test suite.
 */
import { resolve } from "node:path"

const BIN = resolve(import.meta.dir, "../../node_modules/.bin/agent-browser")

async function main() {
  console.log("[agent-browser] Ensuring Chromium is installed...")
  const install = await Bun.$`${BIN} install`.text().catch(() => "")
  console.log(install.trim() || "[agent-browser] Chromium ready.")

  console.log("[agent-browser] Running smoke tests...")
  const proc = Bun.spawn(
    ["bun", "test", "tests/", "--timeout", "120000"],
    {
      // Run from e2e/agent-browser/ so its bunfig.toml overrides the parent (no happydom preload)
      cwd: import.meta.dir,
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env },
    },
  )
  const exitCode = await proc.exited
  process.exit(exitCode)
}

main()
