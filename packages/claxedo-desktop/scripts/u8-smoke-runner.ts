import path from "node:path"

export type U8SmokeKind = "unsigned" | "signed-activation"

export function u8SmokeCommand(kind: U8SmokeKind) {
  return [
    "npx",
    "playwright",
    "test",
    "--config",
    "playwright.config.ts",
    "e2e/playwright/desktop-u8-package-boundary.spec.ts",
    "--grep",
    kind === "unsigned" ? "unsigned startup" : "fixture OAuth activates",
    "--workers=1",
    "--retries=0",
  ]
}

export async function runU8Smoke(kind: U8SmokeKind) {
  const appDir = path.resolve(import.meta.dirname, "../../claxedo-app")
  const child = Bun.spawn({
    cmd: u8SmokeCommand(kind),
    cwd: appDir,
    env: {
      ...process.env,
      CLAXEDO_E2E_DESKTOP: "1",
      CLAXEDO_E2E_SUITE: "core",
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`U8 ${kind} packaged smoke failed with exit code ${exitCode}`)
}
