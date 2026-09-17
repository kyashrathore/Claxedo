import { expect, test } from "bun:test"
import path from "node:path"

import type { RollupBundleMetadata } from "../../../script/product-boundary/normalize-build-manifest"
import { verifyNodeWorkerBundles } from "./node-worker-bundles"

const workspaceRoot = "/workspace"
const desktopRoot = path.join(workspaceRoot, "packages/claxedo-desktop")
const workerEntry = path.join(desktopRoot, "src/main/diagnostics/process-metrics-worker-entry.ts")

function chunk(input: { fileName: string; modules: string[]; imports?: string[]; dynamicImports?: string[] }) {
  return {
    type: "chunk" as const,
    fileName: input.fileName,
    facadeModuleId: input.modules[0] ?? null,
    isEntry: false,
    modules: Object.fromEntries(input.modules.map((id) => [id, {}])),
    imports: input.imports ?? [],
    dynamicImports: input.dynamicImports ?? [],
  }
}

test("a worker whose static closure reaches electron fails the build by name", () => {
  const bundle: RollupBundleMetadata = {
    "process-metrics-worker.js": chunk({
      fileName: "process-metrics-worker.js",
      modules: [workerEntry],
      imports: ["chunks/desktop-account-abc.js", "node:readline"],
    }),
    "chunks/desktop-account-abc.js": chunk({
      fileName: "chunks/desktop-account-abc.js",
      modules: [path.join(desktopRoot, "src/shared/json-read.ts"), path.join(desktopRoot, "src/main/account/index.ts")],
      imports: ["electron"],
    }),
  }
  expect(() => verifyNodeWorkerBundles({ bundle, workspaceRoot, workerEntries: [workerEntry] })).toThrow(
    "packages/claxedo-desktop/src/main/diagnostics/process-metrics-worker-entry.ts: chunks/desktop-account-abc.js -> electron",
  )
})

test("electron behind a dynamic import, or in an unrelated chunk, is not a worker failure", () => {
  const bundle: RollupBundleMetadata = {
    "process-metrics-worker.js": chunk({
      fileName: "process-metrics-worker.js",
      modules: [workerEntry],
      imports: ["chunks/json-read-abc.js", "node:readline"],
      dynamicImports: ["chunks/desktop-account-abc.js"],
    }),
    "chunks/json-read-abc.js": chunk({
      fileName: "chunks/json-read-abc.js",
      modules: [path.join(desktopRoot, "src/shared/json-read.ts")],
    }),
    "index.js": chunk({
      fileName: "index.js",
      modules: [path.join(desktopRoot, "src/main/index.ts")],
      imports: ["electron", "chunks/json-read-abc.js"],
    }),
    "chunks/desktop-account-abc.js": chunk({
      fileName: "chunks/desktop-account-abc.js",
      modules: [path.join(desktopRoot, "src/main/account/index.ts")],
      imports: ["electron"],
    }),
  }
  expect(() => verifyNodeWorkerBundles({ bundle, workspaceRoot, workerEntries: [workerEntry] })).not.toThrow()
})
