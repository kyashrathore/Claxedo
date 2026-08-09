import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  normalizeModuleId,
  normalizeEsbuildBuildManifest,
  normalizeRollupBuildManifest,
  normalizeSourceMapBuildManifest,
  serializeBuildManifest,
  type RollupBundleMetadata,
} from "./normalize-build-manifest"

const ROOT = path.resolve("/repo")

describe("normalize build manifest", () => {
  test("normalizes repository, dependency, virtual, and queried module ids", () => {
    expect(normalizeModuleId("/repo/packages/app/src/index.ts?commonjs-proxy", ROOT)).toBe("packages/app/src/index.ts")
    expect(normalizeModuleId("/repo/node_modules/.bun/hono@4.10.7/node_modules/hono/dist/index.js", ROOT)).toBe("hono/dist/index.js")
    expect(normalizeModuleId("\0vite/modulepreload-polyfill.js", ROOT)).toBe("virtual:vite/modulepreload-polyfill.js")
    expect(() => normalizeModuleId("/another-machine/private.ts", ROOT)).toThrow("outside the workspace")
  })

  test("sorts and deduplicates Rollup modules, chunks, and static/dynamic edges", () => {
    const bundle: RollupBundleMetadata = {
      "assets/z.js": {
        type: "chunk",
        fileName: "assets/z.js",
        facadeModuleId: null,
        isEntry: false,
        modules: {
          "/repo/packages/app/src/z.ts": {},
          "/repo/node_modules/.bun/hono@4.10.7/node_modules/hono/dist/index.js": {},
        },
        imports: ["assets/shared.js"],
        dynamicImports: [],
      },
      "assets/a.js": {
        type: "chunk",
        fileName: "assets/a.js",
        facadeModuleId: "/repo/packages/app/src/index.ts",
        isEntry: true,
        modules: {
          "/repo/packages/app/src/index.ts?x": {},
          "/repo/packages/app/src/z.ts": {},
        },
        imports: ["assets/shared.js"],
        dynamicImports: ["assets/z.js"],
      },
      "logo.svg": { type: "asset", fileName: "logo.svg" },
    }

    expect(normalizeRollupBuildManifest({
      entry: "/repo/packages/app/src/index.ts",
      bundle,
      workspaceRoot: ROOT,
    })).toEqual({
      entry: "packages/app/src/index.ts",
      modules: ["hono/dist/index.js", "packages/app/src/index.ts", "packages/app/src/z.ts"],
      chunks: ["assets/a.js", "assets/z.js"],
      edges: {
        static: ["assets/a.js -> assets/shared.js", "assets/z.js -> assets/shared.js"],
        dynamic: ["assets/a.js -> assets/z.js"],
      },
    })
  })

  test("serialization is deterministic and newline terminated", () => {
    const manifest = normalizeRollupBuildManifest({
      entry: "packages/app/src/index.ts",
      workspaceRoot: ROOT,
      bundle: {},
    })
    expect(serializeBuildManifest(manifest)).toBe(
      '{\n  "entry": "packages/app/src/index.ts",\n  "modules": [],\n  "chunks": [],\n  "edges": {\n    "static": [],\n    "dynamic": []\n  }\n}\n',
    )
  })

  test("normalizes a single-file bundle from its external source map", () => {
    expect(normalizeSourceMapBuildManifest({
      entry: "/repo/packages/connector/src/index.ts",
      sourceMap: { sources: ["../src/z.ts", "../src/index.ts", "../src/z.ts"] },
      sourceMapDirectory: "/repo/packages/connector/dist",
      chunks: ["dist/index.mjs"],
      workspaceRoot: ROOT,
    })).toEqual({
      entry: "packages/connector/src/index.ts",
      modules: ["packages/connector/src/index.ts", "packages/connector/src/z.ts"],
      chunks: ["dist/index.mjs"],
      edges: { static: [], dynamic: [] },
    })
  })

  test("normalizes esbuild and Wrangler inputs, outputs, and import kinds", () => {
    expect(normalizeEsbuildBuildManifest({
      entry: "/repo/packages/server/src/worker.ts",
      workingDirectory: "/repo/packages/server",
      workspaceRoot: ROOT,
      metafile: {
        inputs: {
          "src/worker.ts": {
            imports: [
              { path: "src/static.ts", kind: "import-statement" },
              { path: "src/lazy.ts", kind: "dynamic-import" },
              { path: "node:crypto", kind: "import-statement", external: true },
            ],
          },
          "src/static.ts": {},
          "src/lazy.ts": {},
          "../../node_modules/.bun/hono@4/node_modules/hono/dist/index.js": {},
        },
        outputs: {
          "dist-worker/worker.js": { entryPoint: "src/worker.ts" },
        },
      },
    })).toEqual({
      entry: "packages/server/src/worker.ts",
      modules: [
        "hono/dist/index.js",
        "packages/server/src/lazy.ts",
        "packages/server/src/static.ts",
        "packages/server/src/worker.ts",
      ],
      chunks: ["packages/server/dist-worker/worker.js"],
      edges: {
        static: [
          "packages/server/src/worker.ts -> node:crypto",
          "packages/server/src/worker.ts -> packages/server/src/static.ts",
        ],
        dynamic: ["packages/server/src/worker.ts -> packages/server/src/lazy.ts"],
      },
    })
  })
})
