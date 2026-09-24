import { spawn } from "node:child_process"
import path from "node:path"

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..")
const PLAYWRIGHT = path.join(PACKAGE_ROOT, "node_modules/.bin/playwright")

function parseArgs(args: string[]) {
  let app = process.env.CLAXEDO_E2E_APP ?? "v2"
  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg.startsWith("--app=")) app = arg.slice("--app=".length)
    else if (arg === "--app") app = args[++index] ?? ""
    else rest.push(arg)
  }
  return { app, rest }
}

const { app, rest } = parseArgs(process.argv.slice(2))
if (app !== "v1" && app !== "v2") {
  console.error(`--app must be v1 or v2, got "${app}"`)
  process.exit(2)
}

const child = spawn(PLAYWRIGHT, ["test", "--config", "playwright.config.ts", ...rest], {
  cwd: PACKAGE_ROOT,
  env: { ...process.env, CLAXEDO_E2E_APP: app },
  stdio: "inherit",
})
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
