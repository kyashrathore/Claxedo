import assert from "node:assert/strict"
import test from "node:test"

import { classifyChangedFiles } from "./ci-changes.mjs"

await test("documentation-only changes run documentation checks and no product gates", () => {
  const result = classifyChangedFiles([
    "README.md",
    "public-docs/user-deployed-cloudflare.md",
    "packages/claxedo-app/README.md",
    "packages/claxedo-server/README.md",
  ])
  assert.equal(result.docs, true)
  assert.equal(result.unit, false)
  assert.equal(result.typecheck, false)
  assert.equal(result.windows, false)
  assert.equal(result.boundary_server, false)
  assert.equal(result.boundary_local_server, false)
  assert.equal(result.boundary_host_connector, false)
})

await test("unknown non-documentation paths still receive affected code validation", () => {
  const result = classifyChangedFiles(["config/new-tool.toml"])
  assert.equal(result.docs, false)
  assert.equal(result.unit, true)
  assert.equal(result.typecheck, true)
  assert.equal(result.windows, false)
})

await test("application UI changes run affected code validation and no server or Windows gate", () => {
  const result = classifyChangedFiles(["packages/claxedo-app/src/rail/switcher-items.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.typecheck, true)
  assert.equal(result.windows, false)
  assert.equal(result.boundary_server, false)
  assert.equal(result.boundary_local_server, false)
  assert.equal(result.boundary_host_connector, false)
  assert.equal(result.sandbox_image, false)
})

await test("shared kit changes are ordinary code changes", () => {
  const result = classifyChangedFiles(["packages/ui/src/context/marked.tsx"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, false)
  assert.equal(result.boundary_server, false)
})

await test("the app's rule checks run for app and kit code and nothing else", () => {
  for (const file of ["packages/claxedo-app/src/rail/switcher-items.ts", "packages/claxedo-app/scripts/checks/budget.ts", "packages/ui/src/context/marked.tsx"]) {
    assert.equal(classifyChangedFiles([file]).app_checks, true, file)
  }
  for (const file of ["packages/claxedo-server/src/workspace/routes/session.ts", "packages/claxedo-app/README.md", "packages/ui/src/README.md"]) {
    assert.equal(classifyChangedFiles([file]).app_checks, false, file)
  }
  assert.equal(classifyChangedFiles([]).app_checks, true)
})

await test("server changes select Windows and the server boundary", () => {
  const result = classifyChangedFiles(["packages/claxedo-server/src/workspace/routes/session.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  assert.equal(result.boundary_server, true)
  assert.equal(result.boundary_local_server, false)
})

await test("contract and helpers changes select the server and local-server boundaries", () => {
  for (const file of ["packages/agent-runtime-contract/src/turn-page.ts", "packages/claxedo-helpers/src/json.ts"]) {
    const result = classifyChangedFiles([file])
    assert.equal(result.boundary_server, true, file)
    assert.equal(result.boundary_local_server, true, file)
  }
})

await test("server-core changes select every boundary that consumes it", () => {
  const result = classifyChangedFiles(["packages/claxedo-server-core/src/projects/store.ts"])
  assert.equal(result.boundary_server, true)
  assert.equal(result.boundary_local_server, true)
  assert.equal(result.boundary_host_connector, true)
})

await test("cross-platform process runtime changes retain the Windows unit leg", () => {
  const result = classifyChangedFiles(["packages/process-ownership/src/windows-process.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
})

await test("onboarding changes select no lane of their own", () => {
  const result = classifyChangedFiles(["packages/claxedo-app/src/onboarding/wizard.ts"])
  assert.equal(result.unit, true)
  assert.equal("onboarding" in result, false)
})

await test("desktop source changes run source tests but never request a regular desktop build", () => {
  const result = classifyChangedFiles(["packages/claxedo-desktop/src/main/windows.ts"])
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  assert.equal("desktop" in result, false)
})

await test("product-boundary infrastructure selects every boundary gate", () => {
  const result = classifyChangedFiles(["script/product-boundary/verify.ts"])
  assert.equal(result.full, false)
  assert.equal(result.boundary_server, true)
  assert.equal(result.boundary_local_server, true)
  assert.equal(result.boundary_host_connector, true)
})

await test("CI foundations fail open to the complete non-release suite", () => {
  const result = classifyChangedFiles([".github/workflows/test.yml"])
  assert.equal(result.full, true)
  assert.equal(result.windows, true)
  assert.equal(result.boundary_server, true)
})

await test("the shared Bun.build wrapper fails open to the complete non-release suite", () => {
  const result = classifyChangedFiles(["script/bun-build.ts"])
  assert.equal(result.full, true)
  assert.equal(result.unit, true)
  assert.equal(result.windows, true)
  assert.equal(result.boundary_server, true)
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
    "packages/sandbox-manager/src/drivers/cloudflare.ts",
    "packages/workspace-runtime/src/workspace/runtime.ts",
    "packages/harness/src/compose.ts",
    "packages/agent-runtime-contract/src/elicitation.ts",
    ".github/workflows/deploy-cloudflare-sandbox-worker.yml",
  ]) {
    assert.equal(classifyChangedFiles([file]).sandbox_image, true, file)
  }
})

await test("the sandbox image is not rebuilt for changes that cannot reach it", () => {
  for (const file of [
    "packages/claxedo-app/src/rail/switcher-items.ts",
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
