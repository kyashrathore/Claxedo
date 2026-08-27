import { e2eAuthViteEnvironment, resolveE2EAuthMode } from "../e2e/auth-mode"

const authMode = resolveE2EAuthMode()
const appRoot = import.meta.dir + "/.."
const child = Bun.spawn(["bun", "run", "build"], {
  cwd: appRoot,
  env: {
    ...process.env,
    ...e2eAuthViteEnvironment(authMode),
    VITE_CLAXEDO_E2E: "1",
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

const exitCode = await child.exited
if (exitCode !== 0) process.exit(exitCode)

await Bun.write(
  appRoot + "/dist/claxedo-e2e-build.json",
  JSON.stringify({ authMode, gitSha: process.env.GITHUB_SHA ?? null }) + "\n",
)
