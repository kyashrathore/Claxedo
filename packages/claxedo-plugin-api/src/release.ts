import { z } from "zod"
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from "./id"
import type { PluginManifest } from "./manifest"
import { pluginManifestSchema } from "./manifest-schema"

/** Cloudflare's own ceiling on a Worker's modules, and the most a host stores for one bundle of either kind. */
export const PLUGIN_BUNDLE_MAX_BYTES = 10 * 1024 * 1024

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The registry's Ed25519 public keys, raw 32 bytes in base64, by key id. A
 * release signed by any other key is refused; a test key reaches a host only
 * through the host's own test composition, never through this table.
 */
export const PLUGIN_REGISTRY_KEYS: Readonly<Record<string, string>> = Object.freeze({})

export type PluginReleaseBlob = { sha256: string; size: number }

export type PluginRelease = {
  id: string
  version: string
  manifest: PluginManifest
  app: PluginReleaseBlob
  backend?: PluginReleaseBlob | undefined
  /** A forward-only storage generation: a host refuses to replace a release with one whose storage is lower. */
  storage: number
  builtAt: string
}

export type SignedPluginRelease = { release: PluginRelease; signature: string; keyId: string }

const blobSchema = z.object({ sha256: z.string().regex(SHA256_PATTERN), size: z.number().int().positive().max(PLUGIN_BUNDLE_MAX_BYTES) }).strict()

export const pluginReleaseSchema = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX_LENGTH).regex(PLUGIN_ID_PATTERN),
    version: z.string(),
    manifest: pluginManifestSchema,
    app: blobSchema,
    backend: blobSchema.optional(),
    storage: z.number().int().nonnegative(),
    builtAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((release, context) => {
    if (release.manifest.id !== release.id) context.addIssue({ code: "custom", path: ["manifest", "id"], message: `the manifest names ${release.manifest.id}, not ${release.id}` })
    if (release.manifest.version !== release.version) {
      context.addIssue({ code: "custom", path: ["manifest", "version"], message: `the manifest is version ${release.manifest.version}, not ${release.version}` })
    }
    if (Boolean(release.manifest.backend) !== Boolean(release.backend)) {
      context.addIssue({ code: "custom", path: ["backend"], message: "a release carries a backend bundle exactly when its manifest declares a backend" })
    }
  })

export const signedPluginReleaseSchema = z
  .object({ release: z.unknown(), signature: z.string().regex(BASE64_PATTERN), keyId: z.string().regex(KEY_ID_PATTERN) })
  .strict()

export type PluginReleaseErrorCode = "release_malformed" | "release_key_unknown" | "release_signature_invalid"

export class PluginReleaseError extends Error {
  constructor(readonly code: PluginReleaseErrorCode, message: string) {
    super(message)
    this.name = "PluginReleaseError"
  }
}

/** JSON with every object's keys sorted and no whitespace: the bytes a release signature covers. */
export function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonText(entry)}`).join(",")}}`
  }
  const text = JSON.stringify(value)
  if (text === undefined) throw new PluginReleaseError("release_malformed", "a release holds only JSON values")
  return text
}

export function pluginReleaseSigningBytes(release: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJsonText(release))
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

/**
 * The release `signed` carries, once its signature verifies under one of
 * `keys` and it parses as a release. The signature covers the release exactly
 * as published, before the manifest's defaults are filled in.
 */
export async function verifyPluginRelease(signed: unknown, keys: Readonly<Record<string, string>>): Promise<PluginRelease> {
  const envelope = signedPluginReleaseSchema.safeParse(signed)
  if (!envelope.success) throw new PluginReleaseError("release_malformed", "the release is not a signed release")
  const publicKey = Object.hasOwn(keys, envelope.data.keyId) ? keys[envelope.data.keyId] : undefined
  if (!publicKey) throw new PluginReleaseError("release_key_unknown", `no registry key is named ${envelope.data.keyId}`)
  const key = await crypto.subtle.importKey("raw", base64Bytes(publicKey), { name: "Ed25519" }, false, ["verify"])
  const valid = await crypto.subtle.verify("Ed25519", key, base64Bytes(envelope.data.signature), pluginReleaseSigningBytes(envelope.data.release))
  if (!valid) throw new PluginReleaseError("release_signature_invalid", `the release's signature does not verify under ${envelope.data.keyId}`)
  const release = pluginReleaseSchema.safeParse(envelope.data.release)
  if (!release.success) {
    throw new PluginReleaseError("release_malformed", release.error.issues.map((issue) => `${issue.path.join(".") || "release"}: ${issue.message}`).join("; "))
  }
  return release.data
}
