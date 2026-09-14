#!/usr/bin/env node

import { appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const normalize = (file) => file.trim().replaceAll("\\", "/").replace(/^\.\//, "")
const startsWithAny = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix))
const equalsAny = (file, paths) => paths.includes(file)

// `script/bun-build.ts` is the single `Bun.build` wrapper behind every bundle in
// the repository — the desktop server and host-connector bundles, the
// local-server and host-connector builds, workspace-runtime's node bundle, and
// session-ui's mermaid sanitizer verification. Nothing under `script/` belongs
// to a package prefix, so a change to it would otherwise select no gate at all
// and a broken bundler could ship green. Its six consumers span every gate, so
// it fails open to the full suite rather than being enumerated per-gate.
const GLOBAL_FILES = [
  "package.json",
  "bun.lock",
  "turbo.json",
  "script/ci-changes.mjs",
  "script/ci-changes.test.mjs",
  "script/bun-build.ts",
  "script/bun-build.test.ts",
]
const GLOBAL_PREFIXES = [".github/actions/"]
const GLOBAL_WORKFLOWS = [".github/workflows/test.yml", ".github/workflows/typecheck.yml"]

const DOC_PREFIXES = [
  ".github/ISSUE_TEMPLATE/",
  "docs/",
  "public-docs/",
]

const WINDOWS_PREFIXES = [
  "packages/agent-event-runtime/",
  "packages/agent-sdk-runtime/",
  "packages/claxedo-desktop/",
  "packages/claxedo-host-connector/",
  "packages/claxedo-host-serving/",
  "packages/claxedo-local-server/",
  "packages/claxedo-server/",
  "packages/claxedo-server-core/",
  "packages/cli/",
  "packages/sandbox-manager/",
  "packages/wakes/",
  "packages/workspace-relay/",
  "packages/workspace-runtime/",
  "script/cbx-prepare-windows.ps1",
  "script/cbx-test-windows.ps1",
]

const APP_DEPENDENCY_PREFIXES = [
  "packages/claxedo-app/",
  "packages/session-ui/",
  "packages/ui/",
]

const SERVER_DEPENDENCY_PREFIXES = [
  "packages/agent-event-runtime/",
  "packages/agent-sdk-runtime/",
  "packages/claxedo-channels/",
  "packages/claxedo-connections/",
  "packages/claxedo-local-server/",
  "packages/claxedo-mcp/",
  "packages/claxedo-server/",
  "packages/claxedo-server-core/",
  "packages/sandbox-contract/",
  "packages/sandbox-manager/",
  "packages/wakes/",
  "packages/workspace-relay-protocol/",
  "packages/workspace-relay/",
  "packages/workspace-runtime/",
]

const TIER_REAL_APP_PREFIXES = [
  "packages/claxedo-app/e2e/helpers/",
  "packages/claxedo-app/e2e/playwright/real-",
  "packages/claxedo-app/e2e/playwright/web-signed-",
  "packages/claxedo-app/playwright.config.ts",
  "packages/claxedo-app/src/features/session/actions/",
  "packages/claxedo-app/src/features/session/data/",
  "packages/claxedo-app/src/features/session/providers/",
  "packages/claxedo-app/src/features/session/store/",
  "packages/claxedo-app/src/platform/api/",
  "packages/claxedo-app/src/platform/auth/",
  "packages/claxedo-app/src/platform/runtime/",
]

function isDocumentation(file) {
  if (startsWithAny(file, DOC_PREFIXES)) return true
  const name = file.split("/").at(-1) ?? ""
  return /^(README|CHANGELOG|CONTRIBUTING|SECURITY|LICENSE)(\..*)?$/i.test(name) || /\.(md|mdx)$/i.test(file)
}

function isUnitRelevant(file) {
  if (isDocumentation(file)) return false
  // Unknown non-documentation paths fail safe into affected unit/typecheck.
  // Turbo still narrows package work, but a new root config or source tree can
  // never silently produce a green CI run with no code validation.
  return true
}

function isMermaidRelevant(file) {
  return startsWithAny(file, [
    "packages/session-ui/",
    "packages/ui/src/context/marked",
    "packages/claxedo-app/src/features/session/ui/mermaid-timeline",
  ])
}

function isCoreE2ERelevant(file) {
  if (!startsWithAny(file, APP_DEPENDENCY_PREFIXES)) return false
  if (file.includes("/e2e/playwright/real-") || file.includes("/e2e/playwright/web-signed-")) return false
  if (/(^|\/)([^/]+\.)?(test|vitest)\.[cm]?[jt]sx?$/.test(file) && !file.includes("/e2e/")) return false
  return true
}

function isOnboardingRelevant(file) {
  return startsWithAny(file, [
    "packages/claxedo-app/e2e/playwright/onboarding",
    "packages/claxedo-app/src/features/onboarding/",
    "packages/claxedo-app/src/features/session/onboarding/",
  ])
}

function isTierRealRelevant(file) {
  return startsWithAny(file, [...SERVER_DEPENDENCY_PREFIXES, ...TIER_REAL_APP_PREFIXES])
}

function isProductBoundaryInfrastructure(file) {
  return file.startsWith("script/product-boundary/")
}

function resultFor(files, forceFull, reason) {
  const full =
    forceFull ||
    files.length === 0 ||
    files.some(
      (file) => equalsAny(file, [...GLOBAL_FILES, ...GLOBAL_WORKFLOWS]) || startsWithAny(file, GLOBAL_PREFIXES),
    )
  const docs = full || files.some(isDocumentation)
  const unit = full || files.some(isUnitRelevant)
  const codeFiles = files.filter((file) => !isDocumentation(file))
  const windows = full || codeFiles.some((file) => startsWithAny(file, WINDOWS_PREFIXES))
  const boundaryInfrastructure = full || codeFiles.some(isProductBoundaryInfrastructure)

  const boundaryApp = boundaryInfrastructure || codeFiles.some((file) => startsWithAny(file, APP_DEPENDENCY_PREFIXES))
  const boundaryLocalServer =
    boundaryInfrastructure ||
    codeFiles.some((file) =>
      startsWithAny(file, [
        "packages/claxedo-local-server/",
        "packages/claxedo-server-core/",
        "packages/workspace-runtime/",
      ]),
    )
  const boundaryHostConnector =
    boundaryInfrastructure ||
    codeFiles.some((file) =>
      startsWithAny(file, [
        "packages/claxedo-host-connector/",
        "packages/claxedo-server-core/",
        "packages/workspace-relay-protocol/",
      ]),
    )
  const boundaryServer =
    boundaryInfrastructure || codeFiles.some((file) => startsWithAny(file, SERVER_DEPENDENCY_PREFIXES))

  return {
    full,
    docs,
    unit,
    typecheck: unit,
    windows,
    mermaid: full || codeFiles.some(isMermaidRelevant),
    boundary_app: boundaryApp,
    boundary_local_server: boundaryLocalServer,
    boundary_host_connector: boundaryHostConnector,
    boundary_server: boundaryServer,
    core_e2e: full || codeFiles.some(isCoreE2ERelevant),
    onboarding: full || codeFiles.some(isOnboardingRelevant),
    tier_real: full || codeFiles.some(isTierRealRelevant),
    reason,
    files,
  }
}

export function classifyChangedFiles(inputFiles, options = {}) {
  const files = [...new Set(inputFiles.map(normalize).filter(Boolean))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return resultFor(files, options.forceFull === true, options.reason ?? "changed files")
}

export function readChangedFiles(base, head) {
  if (!base || !head || /^0+$/.test(base) || /^0+$/.test(head)) {
    return { files: [], forceFull: true, reason: "missing comparison ref" }
  }

  const diff = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRD", `${base}...${head}`], {
    encoding: "utf8",
  })
  if (diff.status !== 0) {
    const detail = diff.stderr.trim() || `git diff exited ${diff.status ?? "without status"}`
    return { files: [], forceFull: true, reason: `comparison failed: ${detail}` }
  }
  return { files: diff.stdout.split("\n"), forceFull: false, reason: `${base.slice(0, 12)}...${head.slice(0, 12)}` }
}

function writeGitHubOutputs(result, outputFile) {
  const scalarKeys = [
    "full",
    "docs",
    "unit",
    "typecheck",
    "windows",
    "mermaid",
    "boundary_app",
    "boundary_local_server",
    "boundary_host_connector",
    "boundary_server",
    "core_e2e",
    "onboarding",
    "tier_real",
  ]
  const lines = scalarKeys.map((key) => `${key}=${result[key]}`)
  // Keep the matrix structurally valid even when the job-level `if` skips the
  // unit job. GitHub can expand matrix expressions while preparing the job,
  // and an empty vector is rejected before the skip is applied.
  const matrix = [
    { name: "linux", host: "ubuntu-latest" },
    ...(result.windows ? [{ name: "windows", host: "windows-latest" }] : []),
  ]
  lines.push(`unit_matrix=${JSON.stringify(matrix)}`)
  lines.push(`reason=${result.reason.replaceAll("\n", " ")}`)
  appendFileSync(outputFile, `${lines.join("\n")}\n`)
}

function printSummary(result) {
  const selected = Object.entries(result)
    .filter(([, value]) => typeof value === "boolean" && value)
    .map(([key]) => key)
  console.log(`CI change selection: ${selected.join(", ") || "no product gates"}`)
  console.log(`Comparison: ${result.reason}`)
  console.log(`Changed files (${result.files.length}):`)
  for (const file of result.files) console.log(`  ${file}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const forced = process.env.CI_FORCE_FULL === "true"
  const changed = forced
    ? { files: [], forceFull: true, reason: "explicit full run" }
    : readChangedFiles(process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA)
  const result = classifyChangedFiles(changed.files, {
    forceFull: changed.forceFull,
    reason: changed.reason,
  })
  printSummary(result)
  if (process.env.GITHUB_OUTPUT) writeGitHubOutputs(result, process.env.GITHUB_OUTPUT)
}
