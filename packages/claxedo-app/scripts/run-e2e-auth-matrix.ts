import { e2eAuthModes } from "../e2e/auth-mode"

const scripts = process.argv.slice(2)

if (scripts.length === 0) {
  console.error("Usage: bun run ./scripts/run-e2e-auth-matrix.ts <package-script> [...package-script]")
  process.exit(2)
}

let firstFailure = 0

for (const authMode of e2eAuthModes) {
  for (const script of scripts) {
    console.log(`\n[e2e auth matrix] ${authMode}: bun run ${script}`)
    const child = Bun.spawn(["bun", "run", script], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, CLAXEDO_E2E_AUTH_MODE: authMode },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await child.exited
    if (exitCode !== 0 && firstFailure === 0) firstFailure = exitCode
  }
}

process.exit(firstFailure)
