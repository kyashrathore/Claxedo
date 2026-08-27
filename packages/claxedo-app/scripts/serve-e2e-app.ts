import { existsSync } from "node:fs"
import { e2eAuthViteEnvironment, resolveE2EAuthMode } from "../e2e/auth-mode"

const modes = ["dev", "build-preview", "preview"] as const
type Mode = (typeof modes)[number]

const mode = process.argv[2] ?? "dev"
const port = process.argv[3] ?? "4455"
if (!modes.includes(mode as Mode)) {
  console.error(`Unknown E2E serve mode "${mode}". Expected one of: ${modes.join(", ")}.`)
  process.exit(2)
}

const appRoot = import.meta.dir + "/.."
const authMode = resolveE2EAuthMode()
const env = {
  ...process.env,
  ...e2eAuthViteEnvironment(authMode),
  VITE_CLAXEDO_E2E: "1",
}

async function run(command: string[]) {
  const child = Bun.spawn(command, {
    cwd: appRoot,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

if (mode === "build-preview") {
  const exitCode = await run(["bun", "run", "build:e2e"])
  if (exitCode !== 0) process.exit(exitCode)
}

if (mode === "preview" || mode === "build-preview") {
  if (!existsSync(appRoot + "/dist/index.html")) {
    console.error(
      "E2E preview requires packages/claxedo-app/dist/index.html. Build or download the matching artifact first.",
    )
    process.exit(2)
  }
  const manifestFile = Bun.file(appRoot + "/dist/claxedo-e2e-build.json")
  if (!(await manifestFile.exists())) {
    console.error("E2E preview requires dist/claxedo-e2e-build.json so it cannot serve an unverified build.")
    process.exit(2)
  }
  const manifest = (await manifestFile.json()) as { authMode?: string; gitSha?: string | null }
  if (manifest.authMode !== authMode) {
    console.error(`E2E artifact auth mode is "${manifest.authMode ?? "missing"}", expected "${authMode}".`)
    process.exit(2)
  }
  if (process.env.GITHUB_SHA && manifest.gitSha !== process.env.GITHUB_SHA) {
    console.error(`E2E artifact commit is "${manifest.gitSha ?? "missing"}", expected "${process.env.GITHUB_SHA}".`)
    process.exit(2)
  }
  process.exit(
    await run(["bun", "x", "vite", "preview", "--config", "vite.cloud.config.ts", "--port", port, "--strictPort"]),
  )
}

process.exit(await run(["bun", "run", "dev", "--", "--port", port]))
