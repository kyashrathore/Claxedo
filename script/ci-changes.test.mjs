import assert from "node:assert/strict"
import test from "node:test"

import { classifyChangedFiles } from "./ci-changes.mjs"

await test("documentation-only changes run documentation checks and no product gates", () => {
  const result = classifyChangedFiles([
    "README.md",
    "public-docs/self-host-fly.md",
    "packages/claxedo-app/README.md",
    "packages/claxedo-server/README.md",
  ])
  assert.equal(result.docs, true)
  assert.equal(result.unit, false)
  assert.equal(result.typecheck, false)
  assert.equal(result.core_e2e, false)
  assert.equal(result.tier_real, false)
  assert.equal(result.windows, false)
  assert.equal(result.boundary_app, false)
  assert.equal(result.boundary_server, false)
})

await test("unknown non-documentation paths still receive affected code validation", () => {
  const result = classifyChangedFiles(["config/new-tool.toml"])
  assert.equal(result.docs, false)
  assert.equal(result.unit, true)
  assert.equal(result.typecheck, true)
  assert.equal(result.core_e2e, false)
})

await test("ordinary application UI changes run affected code and core browser gates", () => {
  const result = classifyChangedFiles(["packages/claxedo-app/src/app/workbench/rail/workspace-tab.tsx"])
  assert.equal(result.unit, true)
  assert.equal(result.typecheck, true)
  assert.equal(result.core_e2e, true)
  assert.equal(result.windows, false)
  assert.equal(result.mermaid, false)
  assert.equal(result.tier_real, false)
  assert.equal(result.boundary_app, true)
})

await test("Mermaid changes select the real-browser security and wiring gate", () => {
  const result = classifyChangedFiles(["packages/session-ui/src/components/markdown.tsx"])
  assert.equal(result.mermaid, true)
  assert.equal(result.core_e2e, true)
  assert.equal(result.boundary_app, true)
})

await test("server changes select Windows, server boundaries, and tier-real without core browser shards", () => {
  const result = classifyChangedFiles(["packages/claxedo-server/src/workspace/routes/session.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  assert.equal(result.boundary_server, true)
  assert.equal(result.tier_real, true)
  assert.equal(result.core_e2e, false)
})

await test("cross-platform process runtime changes retain the Windows unit leg", () => {
  const result = classifyChangedFiles(["packages/agent-sdk-runtime/src/harnesses/shared/windows-process.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  assert.equal(result.core_e2e, false)
})

await test("onboarding changes add the dedicated onboarding composition", () => {
  const result = classifyChangedFiles(["packages/claxedo-app/src/features/onboarding/setup-page.tsx"])
  assert.equal(result.core_e2e, true)
  assert.equal(result.onboarding, true)
})

await test("desktop source changes run source tests but never request a regular desktop build", () => {
  const result = classifyChangedFiles(["packages/claxedo-desktop/src/main/windows.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  assert.equal(result.core_e2e, false)
  assert.equal("desktop" in result, false)
})

await test("tier-real specs do not launch the unrelated core browser matrix", () => {
  const result = classifyChangedFiles(["packages/claxedo-app/e2e/playwright/web-signed-cloud.spec.ts"])
  assert.equal(result.tier_real, true)
  assert.equal(result.core_e2e, false)
})

await test("CI foundations fail open to the complete non-release suite", () => {
  const result = classifyChangedFiles([".github/workflows/test.yml"])
  assert.equal(result.full, true)
  assert.equal(result.windows, true)
  assert.equal(result.mermaid, true)
  assert.equal(result.core_e2e, true)
  assert.equal(result.onboarding, true)
  assert.equal(result.tier_real, true)
})

await test("the shared Bun.build wrapper fails open to the complete non-release suite", () => {
  const result = classifyChangedFiles(["script/bun-build.ts"])
  assert.equal(result.full, true)
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  // The mermaid sanitizer verification imports it, and mermaid is the one gate
  // whose only coverage of this module is an end-to-end browser run.
  assert.equal(result.mermaid, true)
  assert.equal(result.core_e2e, true)
  assert.equal(result.tier_real, true)
})

await test("an empty or unavailable comparison fails open", () => {
  const result = classifyChangedFiles([])
  assert.equal(result.full, true)
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
})

await test("the sandbox image is selected by the Worker and every package baked into it", () => {
  for (const file of [
    "packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/index.ts",
    "packages/claxedo-server/scripts/sandbox/build-sandbox-image.ts",
    "packages/sandbox-contract/src/index.ts",
    "packages/sandbox-manager/src/daytona.ts",
    "packages/workspace-runtime/src/workspace/runtime.ts",
    "packages/agent-sdk-runtime/src/harnesses/pi/index.ts",
    "packages/agent-runtime-contract/src/elicitation.ts",
    "packages/agent-event-runtime/src/index.ts",
    ".github/workflows/deploy-cloudflare-sandbox-worker.yml",
  ]) {
    assert.equal(classifyChangedFiles([file]).sandbox_image, true, file)
  }
})

await test("the sandbox image is not rebuilt for changes that cannot reach it", () => {
  for (const file of [
    "packages/claxedo-app/src/app/workbench/rail/workspace-tab.tsx",
    "packages/claxedo-server/src/platform/auth/better-auth-configuration.ts",
    "packages/claxedo-desktop/src/main/index.ts",
    "packages/workspace-relay/src/cloudflare.ts",
    ".github/workflows/deploy-staging.yml",
  ]) {
    assert.equal(classifyChangedFiles([file]).sandbox_image, false, file)
  }
})

await test("a documentation change inside a baked package does not rebuild the sandbox image", () => {
  assert.equal(classifyChangedFiles(["packages/workspace-runtime/README.md"]).sandbox_image, false)
})

await test("an unavailable comparison rebuilds the sandbox image rather than assuming it is current", () => {
  assert.equal(classifyChangedFiles([]).sandbox_image, true)
})
