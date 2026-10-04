import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { readBuildManifest } from "../../../script/product-boundary/emitted-manifest"
import {
  normalizeModuleId,
  normalizeRollupEntryBuildManifest,
  serializeBuildManifest,
  type RollupBundleMetadata,
} from "../../../script/product-boundary/normalize-build-manifest"

const DEFAULT_DESKTOP_ROOT = fileURLToPath(new URL("../", import.meta.url))

export const DESKTOP_BOUNDARY_MANIFEST_DIR = "out/product-boundary"
export const DESKTOP_MAIN_BOUNDARY_MANIFEST = `${DESKTOP_BOUNDARY_MANIFEST_DIR}/desktop-main.json`
export const DESKTOP_ACCOUNT_BOUNDARY_MANIFEST = `${DESKTOP_BOUNDARY_MANIFEST_DIR}/desktop-account.json`
export const DESKTOP_RENDERER_BOUNDARY_MANIFEST = `${DESKTOP_BOUNDARY_MANIFEST_DIR}/desktop-renderer-local.json`

const RENDERER_ENTRY = "src/renderer/main.tsx"

export const REQUIRED_DESKTOP_BOUNDARY_MANIFEST_ENTRIES = [
  DESKTOP_MAIN_BOUNDARY_MANIFEST,
  DESKTOP_RENDERER_BOUNDARY_MANIFEST,
] as const

function includesEntry(bundle: RollupBundleMetadata, entry: string, workspaceRoot: string) {
  const normalizedEntry = normalizeModuleId(entry, workspaceRoot)
  return Object.values(bundle).some((item) =>
    item.type === "chunk" && Object.keys(item.modules).some((id) =>
      normalizeModuleId(id, workspaceRoot) === normalizedEntry,
    ),
  )
}

function writeManifest(desktopRoot: string, file: string, manifest: ReturnType<typeof normalizeRollupEntryBuildManifest>) {
  fs.mkdirSync(path.join(desktopRoot, DESKTOP_BOUNDARY_MANIFEST_DIR), { recursive: true })
  fs.writeFileSync(path.join(desktopRoot, file), serializeBuildManifest(manifest))
}

/** Rollup metadata producer for Electron main's static base and lazy account adapter. */
export function desktopMainBoundaryManifestPlugin(desktopRoot: string) {
  const workspaceRoot = path.resolve(desktopRoot, "../..")
  const mainEntry = path.join(desktopRoot, "src/main/index.ts")
  const accountEntry = path.join(desktopRoot, "src/main/account/index.ts")
  return {
    name: "claxedo-desktop-main-boundary-manifests",
    generateBundle(_outputOptions: unknown, bundle: RollupBundleMetadata) {
      const base = normalizeRollupEntryBuildManifest({
        entry: mainEntry,
        bundle,
        workspaceRoot,
        cutAtEntries: [accountEntry],
      })
      writeManifest(desktopRoot, DESKTOP_MAIN_BOUNDARY_MANIFEST, base)
      if (!includesEntry(bundle, accountEntry, workspaceRoot)) {
        fs.rmSync(path.join(desktopRoot, DESKTOP_ACCOUNT_BOUNDARY_MANIFEST), { force: true })
        return
      }
      writeManifest(desktopRoot, DESKTOP_ACCOUNT_BOUNDARY_MANIFEST, normalizeRollupEntryBuildManifest({
        entry: accountEntry,
        bundle,
        workspaceRoot,
        includeDynamicImports: true,
        excludeChunks: base.chunks,
      }))
    },
  }
}

/** Rollup metadata producer for the renderer's static closure. */
export function desktopRendererBoundaryManifestPlugin(desktopRoot: string) {
  const workspaceRoot = path.resolve(desktopRoot, "../..")
  const entry = path.join(desktopRoot, RENDERER_ENTRY)
  return {
    name: "claxedo-desktop-renderer-boundary-manifests",
    generateBundle(_outputOptions: unknown, bundle: RollupBundleMetadata) {
      writeManifest(desktopRoot, DESKTOP_RENDERER_BOUNDARY_MANIFEST, normalizeRollupEntryBuildManifest({ entry, bundle, workspaceRoot }))
    },
  }
}

/** Remove manifests from another capability build before Rollup starts. */
export function clearDesktopBoundaryManifests(root = DEFAULT_DESKTOP_ROOT) {
  fs.rmSync(path.join(root, DESKTOP_BOUNDARY_MANIFEST_DIR), { recursive: true, force: true })
}

/** Validate deterministic build metadata before the build contract fingerprints it. */
export function verifyDesktopBoundaryManifestSet(root: string) {
  const expected = new Map([
    [DESKTOP_MAIN_BOUNDARY_MANIFEST, "packages/claxedo-desktop/src/main/index.ts"],
    [DESKTOP_RENDERER_BOUNDARY_MANIFEST, `packages/claxedo-desktop/${RENDERER_ENTRY}`],
  ])
  const directory = path.join(root, DESKTOP_BOUNDARY_MANIFEST_DIR)
  const actual = fs.existsSync(directory)
    ? fs.readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .map((file) => `${DESKTOP_BOUNDARY_MANIFEST_DIR}/${file}`)
        .sort()
    : []
  const required = [...expected.keys()].sort()
  const allowed = [...required, DESKTOP_ACCOUNT_BOUNDARY_MANIFEST].sort()
  if (!required.every((file) => actual.includes(file)) || actual.some((file) => !allowed.includes(file))) {
    throw new Error(
      `desktop boundary manifest set mismatch: expected ${required.join(", ")} plus the optional account manifest; ` +
        `found ${actual.join(", ") || "none"}`,
    )
  }

  if (actual.includes(DESKTOP_ACCOUNT_BOUNDARY_MANIFEST)) {
    expected.set(DESKTOP_ACCOUNT_BOUNDARY_MANIFEST, "packages/claxedo-desktop/src/main/account/index.ts")
  }

  for (const [relative, entry] of expected) {
    const manifest = readBuildManifest(path.join(root, relative))
    if (manifest.entry !== entry) throw new Error(`${relative} entry is ${manifest.entry}; expected ${entry}`)
    if (manifest.modules.length === 0) throw new Error(`${relative} reports no modules`)
    if (manifest.chunks.length === 0) throw new Error(`${relative} reports no chunks`)
  }

  const verifyOptional = (input: { base: string; optional: string; chunkMarker: string }) => {
    if (!expected.has(input.optional)) return
    const base = readBuildManifest(path.join(root, input.base))
    const optional = readBuildManifest(path.join(root, input.optional))
    const overlaps = optional.chunks.filter((chunk) => base.chunks.includes(chunk))
    if (overlaps.length > 0) throw new Error(`${input.optional} repeats base chunks: ${overlaps.join(", ")}`)
    const rootChunks = optional.chunks.filter((chunk) => chunk.includes(input.chunkMarker))
    if (rootChunks.length !== 1) {
      throw new Error(`${input.optional} must own exactly one fingerprinted ${input.chunkMarker} chunk`)
    }
    if (!base.edges.dynamic.some((edge) => edge.endsWith(` -> ${rootChunks[0]}`))) {
      throw new Error(`${input.base} does not dynamically reference ${rootChunks[0]}`)
    }
  }
  verifyOptional({
    base: DESKTOP_MAIN_BOUNDARY_MANIFEST,
    optional: DESKTOP_ACCOUNT_BOUNDARY_MANIFEST,
    chunkMarker: "desktop-account-",
  })

  return [...expected.keys()].sort()
}
