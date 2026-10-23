import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const cli = path.resolve(import.meta.dirname, "../../cli")
const target = path.resolve(import.meta.dirname, "../src/routes/hosted/connect-installers.generated.ts")

export function connectInstallersModule() {
  const posix = readFileSync(path.join(cli, "install.sh"), "utf8")
  const powershell = readFileSync(path.join(cli, "install.ps1"), "utf8")
  return [
    "// Generated from packages/cli/install.sh and install.ps1 by `bun run generate:connect-installers`.",
    `export const POSIX_INSTALLER = ${JSON.stringify(posix)}`,
    `export const POWERSHELL_INSTALLER = ${JSON.stringify(powershell)}`,
    "",
  ].join("\n")
}

if (import.meta.main) {
  const expected = connectInstallersModule()
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== expected) {
      console.error(`${path.relative(process.cwd(), target)} is stale; run bun run generate:connect-installers`)
      process.exit(1)
    }
  } else {
    writeFileSync(target, expected)
  }
}
