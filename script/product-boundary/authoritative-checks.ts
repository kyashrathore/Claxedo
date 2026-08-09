import { spawnSync } from "node:child_process"
import path from "node:path"

import { REPO_ROOT } from "./closure.ts"

export type AuthoritativeCheck = {
  label: string
  cwd: string
  command: string[]
  env?: Record<string, string>
}

/**
 * Existing repository gates, composed by product.
 *
 * These checks remain the authoritative owners of their individual contracts:
 * this table only gives each product one public command that runs all of them.
 * Keeping commands as data also makes omissions and accidental recursion
 * reviewable and unit-testable.
 */
export const AUTHORITATIVE_CHECKS: Record<string, AuthoritativeCheck[]> = {
  "@claxedo/app": [
    {
      label: "local renderer source closure",
      cwd: "packages/claxedo-app",
      command: ["bun", "test", "./src/architecture/local-entry-closure.guard.test.ts"],
    },
    {
      label: "local renderer build",
      cwd: "packages/claxedo-app",
      command: ["bun", "run", "build:local"],
    },
    {
      label: "identity-marker positive-control build",
      cwd: "packages/claxedo-app",
      command: ["bun", "run", "build:marker-control"],
    },
    {
      label: "local emitted-bundle identity",
      cwd: "packages/claxedo-app",
      command: ["bun", "run", "check:local-bundle"],
      env: { CLAXEDO_MARKER_CONTROL_DIR: "dist-marker-control" },
    },
  ],
  "@claxedo/local-server": [
    {
      label: "local-server published and self-hosted closure",
      cwd: "packages/claxedo-local-server",
      command: [
        "node",
        "./node_modules/vitest/vitest.mjs",
        "run",
        "src/architecture/local-closure.test.ts",
        "src/self-hosted-execution.test.ts",
        "--reporter=default",
      ],
    },
  ],
  "@claxedo/host-connector": [
    {
      label: "host-connector production build",
      cwd: "packages/claxedo-host-connector",
      command: ["bun", "run", "build"],
    },
    {
      label: "host-connector built entry smoke",
      cwd: "packages/claxedo-host-connector",
      command: ["bun", "run", "smoke:build"],
    },
    {
      label: "host-connector source closure",
      cwd: "packages/claxedo-host-connector",
      command: [
        "node",
        "./node_modules/vitest/vitest.mjs",
        "run",
        "src/connector-closure.test.ts",
        "--reporter=default",
      ],
    },
  ],
  "@claxedo/server": [
    {
      label: "cloud and self-hosted deployment closures",
      cwd: "packages/claxedo-server",
      command: [
        "node",
        "./node_modules/vitest/vitest.mjs",
        "run",
        "src/deployments/deployment-closures.test.ts",
        "src/deployments/hosted-workerd/worker.import-graph.test.ts",
        "--reporter=default",
      ],
    },
    {
      label: "self-hosted local-server public subpath",
      cwd: "packages/claxedo-local-server",
      command: [
        "node",
        "./node_modules/vitest/vitest.mjs",
        "run",
        "src/self-hosted-execution.test.ts",
        "--reporter=default",
      ],
    },
  ],
  "@claxedo/desktop": [
    {
      label: "unsigned renderer and packaged-resource boundaries",
      cwd: "packages/claxedo-desktop",
      command: [
        "bun",
        "test",
        "./src/renderer/renderer-entry-closure.guard.test.ts",
        "./scripts/package-structure.test.ts",
      ],
    },
  ],
}

export type CheckRunner = (check: AuthoritativeCheck) => number

export const runCheck: CheckRunner = (check) => {
  const [command, ...args] = check.command
  if (!command) return 2
  const result = spawnSync(command, args, {
    cwd: path.join(REPO_ROOT, check.cwd),
    env: { ...process.env, ...check.env },
    stdio: "inherit",
  })
  if (result.error) {
    console.error(`  ${result.error.message}`)
    return 2
  }
  return result.status ?? 2
}

export function runAuthoritativeChecks(product: string, runner: CheckRunner = runCheck): boolean {
  const checks = AUTHORITATIVE_CHECKS[product]
  if (!checks?.length) {
    throw new Error(`${product} has no authoritative checks — refusing to report success`)
  }

  for (const check of checks) {
    console.log(`\n→ ${product}: ${check.label}`)
    const status = runner(check)
    if (status !== 0) {
      console.error(`✗ ${product}: ${check.label} exited ${status}`)
      return false
    }
    console.log(`✓ ${product}: ${check.label}`)
  }
  return true
}
