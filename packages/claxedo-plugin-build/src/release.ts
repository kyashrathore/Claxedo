import { sha256Hex } from "@claxedo/helpers/crypto"
import type { PluginIndex, PluginIndexEntry, SignedPluginIndex } from "@claxedo/plugin-api/registry-index"
import { pluginReleaseSigningBytes, type PluginRelease, type PluginReleaseBlob, type SignedPluginRelease } from "@claxedo/plugin-api/release"
import { buildPluginBackend } from "./backend"
import { buildPluginApp } from "./build"
import { PluginBuildError } from "./errors"

export type PluginReleaseBuild = {
  release: PluginRelease
  /** Each bundle's code by its SHA-256, as the registry stores it under `blobs/<sha256>`. */
  blobs: ReadonlyMap<string, string>
}

async function blobOf(code: string): Promise<PluginReleaseBlob> {
  return { sha256: await sha256Hex(code), size: new TextEncoder().encode(code).byteLength }
}

/** Builds a plugin's app bundle, minified, and its backend when it declares one, into an unsigned release. */
export async function buildPluginRelease(options: { rootDir: string; storage?: number; builtAt?: Date }): Promise<PluginReleaseBuild> {
  const app = await buildPluginApp({ rootDir: options.rootDir, minify: true })
  if (app.manifest.backend?.tools) {
    throw new PluginBuildError("manifest", [{ file: "package.json", message: "claxedo.backend.tools is declared, and a release cannot carry its tool declarations yet" }])
  }
  const backend = app.manifest.backend ? await buildPluginBackend({ rootDir: options.rootDir }) : undefined
  const appBlob = await blobOf(app.code)
  const backendBlob = backend ? await blobOf(backend.code) : undefined
  const blobs = new Map([[appBlob.sha256, app.code], ...(backend && backendBlob ? [[backendBlob.sha256, backend.code] as const] : [])])
  return {
    release: {
      id: app.manifest.id,
      version: app.manifest.version,
      manifest: app.manifest,
      app: appBlob,
      ...(backendBlob ? { backend: backendBlob } : {}),
      storage: options.storage ?? 1,
      builtAt: (options.builtAt ?? new Date()).toISOString(),
    },
    blobs,
  }
}

async function signatureOf(payload: unknown, privateKey: CryptoKey): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, pluginReleaseSigningBytes(payload)))
  return btoa(String.fromCharCode(...signature))
}

/** Signs `release` with the registry's Ed25519 private key over its canonical JSON. */
export async function signPluginRelease(release: PluginRelease, privateKey: CryptoKey, keyId: string): Promise<SignedPluginRelease> {
  return { release, keyId, signature: await signatureOf(release, privateKey) }
}

/** Signs the registry's `index` with its Ed25519 private key over its canonical JSON. */
export async function signPluginIndex(index: PluginIndex, privateKey: CryptoKey, keyId: string): Promise<SignedPluginIndex> {
  return { index, keyId, signature: await signatureOf(index, privateKey) }
}

function versionParts(version: string): readonly number[] {
  return (version.split("-")[0] ?? "").split(".").map(Number)
}

function newerFirst(left: string, right: string): number {
  const [a, b] = [versionParts(left), versionParts(right)]
  for (let part = 0; part < 3; part++) {
    const difference = (b[part] ?? 0) - (a[part] ?? 0)
    if (difference !== 0) return difference
  }
  return left.includes("-") === right.includes("-") ? right.localeCompare(left) : left.includes("-") ? 1 : -1
}

/** `index` with `release` published: its plugin's versions gain the release's, and the newest version's manifest is the one listed. */
export function indexWithRelease(index: PluginIndex | undefined, release: PluginRelease, description: string | undefined, builtAt: Date): PluginIndex {
  const entries = index?.entries ?? []
  const previous = entries.find((entry) => entry.id === release.id)
  const versions = [...new Set([release.version, ...(previous?.versions ?? [])])].sort(newerFirst)
  const latest = versions[0] ?? release.version
  const listed = latest === release.version || !previous ? { name: release.manifest.name, manifest: release.manifest, description } : previous
  const entry: PluginIndexEntry = {
    id: release.id,
    name: listed.name,
    ...(listed.description ? { description: listed.description } : {}),
    latest,
    versions,
    manifest: listed.manifest,
  }
  const others = entries.filter((candidate) => candidate.id !== release.id)
  return { entries: [...others, entry].sort((left, right) => left.id.localeCompare(right.id)), builtAt: builtAt.toISOString() }
}
