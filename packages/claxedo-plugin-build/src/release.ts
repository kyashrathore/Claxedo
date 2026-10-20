import { sha256Hex } from "@claxedo/helpers/crypto"
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

/** Signs `release` with the registry's Ed25519 private key over its canonical JSON. */
export async function signPluginRelease(release: PluginRelease, privateKey: CryptoKey, keyId: string): Promise<SignedPluginRelease> {
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, pluginReleaseSigningBytes(release)))
  return { release, keyId, signature: btoa(String.fromCharCode(...signature)) }
}
