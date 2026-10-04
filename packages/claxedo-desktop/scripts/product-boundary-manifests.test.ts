import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readBuildManifest } from "../../../script/product-boundary/emitted-manifest"
import type { RollupBundleMetadata } from "../../../script/product-boundary/normalize-build-manifest"
import {
  DESKTOP_ACCOUNT_BOUNDARY_MANIFEST,
  DESKTOP_MAIN_BOUNDARY_MANIFEST,
  DESKTOP_RENDERER_BOUNDARY_MANIFEST,
  clearDesktopBoundaryManifests,
  desktopMainBoundaryManifestPlugin,
  desktopRendererBoundaryManifestPlugin,
  verifyDesktopBoundaryManifestSet,
} from "./product-boundary-manifests"

function desktopFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-desktop-boundary-"))
  const root = path.join(workspace, "packages/claxedo-desktop")
  fs.mkdirSync(root, { recursive: true })
  return { workspace, root }
}

function chunk(input: {
  fileName: string
  modules: string[]
  imports?: string[]
  dynamicImports?: string[]
}) {
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

test("desktop plugins split main's static startup from its separately fingerprinted account chunk", () => {
  const { workspace, root } = desktopFixture()
  try {
    const mainBundle: RollupBundleMetadata = {
      "index.js": chunk({
        fileName: "index.js",
        modules: [path.join(root, "src/main/index.ts")],
        imports: ["desktop-account-abc123.js"],
        dynamicImports: ["desktop-account-abc123.js"],
      }),
      "desktop-account-abc123.js": chunk({
        fileName: "desktop-account-abc123.js",
        modules: [path.join(root, "src/main/account/index.ts")],
      }),
    }
    desktopMainBoundaryManifestPlugin(root).generateBundle({}, mainBundle)

    const rendererBundle: RollupBundleMetadata = {
      "assets/main.js": chunk({
        fileName: "assets/main.js",
        modules: [path.join(root, "src/renderer/main.tsx")],
      }),
    }
    desktopRendererBoundaryManifestPlugin(root).generateBundle({}, rendererBundle)

    expect(verifyDesktopBoundaryManifestSet(root)).toEqual([
      DESKTOP_ACCOUNT_BOUNDARY_MANIFEST,
      DESKTOP_MAIN_BOUNDARY_MANIFEST,
      DESKTOP_RENDERER_BOUNDARY_MANIFEST,
    ].sort())

    const main = readBuildManifest(path.join(root, DESKTOP_MAIN_BOUNDARY_MANIFEST))
    const renderer = readBuildManifest(path.join(root, DESKTOP_RENDERER_BOUNDARY_MANIFEST))
    expect(main.modules).not.toContain("packages/claxedo-desktop/src/main/account/index.ts")
    expect(main.edges.dynamic).toEqual(["index.js -> desktop-account-abc123.js"])
    expect(renderer.entry).toBe("packages/claxedo-desktop/src/renderer/main.tsx")

    desktopMainBoundaryManifestPlugin(root).generateBundle({}, { "index.js": mainBundle["index.js"] })
    expect(verifyDesktopBoundaryManifestSet(root)).toEqual([
      DESKTOP_MAIN_BOUNDARY_MANIFEST,
      DESKTOP_RENDERER_BOUNDARY_MANIFEST,
    ].sort())
    expect(fs.existsSync(path.join(root, DESKTOP_ACCOUNT_BOUNDARY_MANIFEST))).toBe(false)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test("desktop manifest verification rejects stale extras and cleanup removes them", () => {
  const { workspace, root } = desktopFixture()
  try {
    const writeBase = (file: string, entry: string, chunkName: string) => {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, JSON.stringify({
        entry,
        modules: [entry],
        chunks: [chunkName],
        edges: { static: [], dynamic: [] },
      }))
    }
    writeBase(DESKTOP_MAIN_BOUNDARY_MANIFEST, "packages/claxedo-desktop/src/main/index.ts", "index.js")
    writeBase(
      DESKTOP_RENDERER_BOUNDARY_MANIFEST,
      "packages/claxedo-desktop/src/renderer/main.tsx",
      "assets/main.js",
    )
    writeBase("out/product-boundary/stale.json", "stale.ts", "stale.js")

    expect(() => verifyDesktopBoundaryManifestSet(root)).toThrow("manifest set mismatch")
    clearDesktopBoundaryManifests(root)
    expect(fs.existsSync(path.join(root, "out/product-boundary"))).toBe(false)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
