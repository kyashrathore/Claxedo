import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  normalizeModuleId,
  normalizeEsbuildBuildManifest,
  normalizeRollupEntryBuildManifest,
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

  test("entry-scoped Rollup metadata records a dynamic edge without counting its optional descendants", () => {
    const bundle: RollupBundleMetadata = {
      "assets/local.js": {
        type: "chunk",
        fileName: "assets/local.js",
        facadeModuleId: "/repo/packages/desktop/index.local.html",
        isEntry: true,
        modules: { "/repo/packages/desktop/src/local.tsx": {} },
        // Vite's module-preload analysis may list a lazy root in imports AND
        // dynamicImports. The explicit lazy-entry cut point is authoritative.
        imports: ["assets/shared.js", "assets/hosted.js"],
        dynamicImports: ["assets/hosted.js"],
      },
      "assets/shared.js": {
        type: "chunk",
        fileName: "assets/shared.js",
        facadeModuleId: null,
        isEntry: false,
        modules: { "/repo/packages/app/src/shared.ts": {} },
        imports: [],
        dynamicImports: [],
      },
      "assets/hosted.js": {
        type: "chunk",
        fileName: "assets/hosted.js",
        facadeModuleId: "/repo/packages/desktop/src/hosted.ts",
        isEntry: false,
        modules: { "/repo/packages/desktop/src/hosted.ts": {} },
        imports: ["assets/shared.js"],
        dynamicImports: ["assets/hosted-child.js"],
      },
      "assets/hosted-child.js": {
        type: "chunk",
        fileName: "assets/hosted-child.js",
        facadeModuleId: null,
        isEntry: false,
        modules: { "/repo/packages/cloud/src/lazy.ts": {} },
        imports: [],
        dynamicImports: [],
      },
    }

    const base = normalizeRollupEntryBuildManifest({
      entry: "/repo/packages/desktop/src/local.tsx",
      bundle,
      workspaceRoot: ROOT,
      cutAtEntries: ["/repo/packages/desktop/src/hosted.ts"],
    })
    expect(base).toEqual({
      entry: "packages/desktop/src/local.tsx",
      modules: ["packages/app/src/shared.ts", "packages/desktop/src/local.tsx"],
      chunks: ["assets/local.js", "assets/shared.js"],
      edges: {
        static: ["assets/local.js -> assets/hosted.js", "assets/local.js -> assets/shared.js"],
        dynamic: ["assets/local.js -> assets/hosted.js"],
      },
    })

    expect(normalizeRollupEntryBuildManifest({
      entry: "/repo/packages/desktop/src/hosted.ts",
      bundle,
      workspaceRoot: ROOT,
      includeDynamicImports: true,
      excludeChunks: base.chunks,
    })).toEqual({
      entry: "packages/desktop/src/hosted.ts",
      modules: ["packages/cloud/src/lazy.ts", "packages/desktop/src/hosted.ts"],
      chunks: ["assets/hosted-child.js", "assets/hosted.js"],
      edges: {
        static: ["assets/hosted.js -> assets/shared.js"],
        dynamic: ["assets/hosted.js -> assets/hosted-child.js"],
      },
    })
  })

  test("entry-scoped Rollup metadata rejects a missing or ambiguous entry module", () => {
    const chunk = {
      type: "chunk" as const,
      fileName: "assets/a.js",
      facadeModuleId: null,
      isEntry: false,
      modules: { "/repo/packages/app/src/index.ts": {} },
      imports: [],
      dynamicImports: [],
    }
    expect(() => normalizeRollupEntryBuildManifest({
      entry: "/repo/packages/app/src/missing.ts",
      bundle: { "assets/a.js": chunk },
      workspaceRoot: ROOT,
    })).toThrow("found none")
    expect(() => normalizeRollupEntryBuildManifest({
      entry: "/repo/packages/app/src/index.ts",
      bundle: { "assets/a.js": chunk, "assets/b.js": { ...chunk, fileName: "assets/b.js" } },
      workspaceRoot: ROOT,
    })).toThrow("found assets/a.js, assets/b.js")

    expect(() => normalizeRollupEntryBuildManifest({
      entry: "/repo/packages/app/src/index.ts",
      bundle: { "assets/a.js": chunk },
      workspaceRoot: ROOT,
      cutAtEntries: ["/repo/packages/app/src/optional-not-emitted.ts"],
    })).not.toThrow()
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
