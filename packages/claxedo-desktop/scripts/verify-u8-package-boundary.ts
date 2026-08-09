#!/usr/bin/env bun

export type U8PackageBoundaryStep = {
  label: string
  command: string[]
  env?: Record<string, string>
}

export function u8PackageBoundarySteps(
  platform: NodeJS.Platform = process.platform,
  options: { existingPackage?: boolean } = {},
): U8PackageBoundaryStep[] {
  if (platform !== "darwin") {
    throw new Error("verify:u8-package-boundary requires macOS because the contract qualifies a packaged macOS artifact")
  }
  return [
    ...(!options.existingPackage ? [{
      label: "signed-capable package",
      command: ["bun", "run", "package:mac", "--", "--dir", "--publish", "never"],
      env: {
        VITE_AUTH_ENABLED: "true",
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
      },
    }] : []),
    {
      label: "packaged resource inventory",
      command: ["bun", "./scripts/verify-package-contents.ts"],
    },
    {
      label: "unsigned startup trace",
      command: ["bun", "./scripts/u8-packaged-smoke.ts"],
    },
    {
      label: "signed activation trace",
      command: ["bun", "./scripts/u8-signed-activation-smoke.ts"],
    },
  ]
}

async function runStep(step: U8PackageBoundaryStep) {
  console.log(`[u8-package-boundary] ${step.label}`)
  const child = Bun.spawn({
    cmd: step.command,
    cwd: import.meta.dirname + "/..",
    env: { ...process.env, ...step.env },
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${step.label} failed with exit code ${exitCode}`)
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2))
  const supported = new Set(["--existing-package"])
  const unknown = [...args].filter((argument) => !supported.has(argument))
  if (unknown.length > 0) throw new Error(`unknown verify:u8-package-boundary argument(s): ${unknown.join(", ")}`)
  for (const step of u8PackageBoundarySteps(process.platform, { existingPackage: args.has("--existing-package") })) {
    await runStep(step)
  }
  console.log("[u8-package-boundary] packaged resource, unsigned startup, and signed activation contracts passed")
}
