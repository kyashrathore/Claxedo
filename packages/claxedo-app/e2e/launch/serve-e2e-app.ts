import { existsSync } from "node:fs"
import { e2eAppViteEnvironment, resolveE2EAuthMode } from "../auth-mode"
import { readString } from "../../src/lib/record"

const modes = ["dev", "build-preview", "preview"] as const
type Mode = (typeof modes)[number]

function isMode(value: string): value is Mode {
  return (modes as readonly string[]).includes(value)
}

const mode = process.argv[2] ?? "dev"
const port = process.argv[3] ?? "4455"
if (!isMode(mode)) {
  console.error(`Unknown E2E serve mode "${mode}". Expected one of: ${modes.join(", ")}.`)
  process.exit(2)
}

const appRoot = import.meta.dir + "/../.."
const authMode = resolveE2EAuthMode()
const env = {
  ...process.env,
  ...e2eAppViteEnvironment(authMode),
}
const fixtureBackend = process.env.CLAXEDO_TIER_REAL_E2E === "1"
  ? process.env.VITE_CLAXEDO_SERVER_URL
  : undefined
const fixtureOrigin = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`

async function run(command: string[], overrides: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd: appRoot,
    env: { ...env, ...overrides },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

if (mode === "build-preview") {
  const exitCode = await run(["bun", "run", "build:e2e"], fixtureBackend
    ? { VITE_CLAXEDO_SERVER_URL: fixtureOrigin }
    : {})
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
  const manifest: unknown = await manifestFile.json()
  const manifestAuthMode = readString(manifest, "authMode")
  const manifestGitSha = readString(manifest, "gitSha")
  if (manifestAuthMode !== authMode) {
    console.error(`E2E artifact auth mode is "${manifestAuthMode ?? "missing"}", expected "${authMode}".`)
    process.exit(2)
  }
  if (process.env.GITHUB_SHA && manifestGitSha !== process.env.GITHUB_SHA) {
    console.error(`E2E artifact commit is "${manifestGitSha ?? "missing"}", expected "${process.env.GITHUB_SHA}".`)
    process.exit(2)
  }
  process.exit(
    await run(fixtureBackend
      ? ["node", "./e2e/helpers/fixture-web-preview.mjs", "dist", port, fixtureBackend]
      : ["bun", "x", "vite", "preview", "--config", "vite.cloud.config.ts", "--port", port, "--strictPort"]),
  )
}

process.exit(fixtureBackend
  ? await run(["node", "./e2e/helpers/fixture-web-preview.mjs", "dist", port, fixtureBackend], {
    VITE_CLAXEDO_SERVER_URL: fixtureOrigin,
    CLAXEDO_E2E_FIXTURE_DEV: "1",
  })
  : await run(["bun", "run", "dev", "--", "--port", port]))
