import { z } from "zod"
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from "./id"
import type { PluginManifest } from "./manifest"
import { pluginManifestSchema } from "./manifest-schema"

/** Cloudflare's own ceiling on a Worker's modules, and the most a host stores for one bundle of either kind. */
export const PLUGIN_BUNDLE_MAX_BYTES = 10 * 1024 * 1024

const SHA256_PATTERN = /^[0-9a-f]{64}$/
export const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The registry's Ed25519 public keys, raw 32 bytes in base64, by key id. A
 * release signed by any other key is refused; a test key reaches a host only
 * through the host's own test composition, never through this table.
 */
export const PLUGIN_REGISTRY_KEYS: Readonly<Record<string, string>> = Object.freeze({})

export type PluginReleaseBlob = { sha256: string; size: number }

export const PLUGIN_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/

/** One agent tool a backend serves, as the release declares it for the platform's MCP proxy. */
export type PluginToolDeclaration = {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  access: "read" | "write"
}

export type PluginRelease = {
  id: string
  version: string
  manifest: PluginManifest
  app: PluginReleaseBlob
  backend?: PluginReleaseBlob | undefined
  /** A forward-only storage generation: a host refuses to replace a release with one whose storage is lower. */
  storage: number
  /** The agent tools the backend serves, present exactly when the manifest declares `backend.tools`. */
  tools?: PluginToolDeclaration[] | undefined
  builtAt: string
}

export type SignedPluginRelease = { release: PluginRelease; signature: string; keyId: string }

const toolDeclarationSchema = z
  .object({
    name: z.string().regex(PLUGIN_TOOL_NAME_PATTERN),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(2048),
    inputSchema: z.record(z.string(), z.unknown()),
    access: z.enum(["read", "write"]),
  })
  .strict()

const blobSchema = z.object({ sha256: z.string().regex(SHA256_PATTERN), size: z.number().int().positive().max(PLUGIN_BUNDLE_MAX_BYTES) }).strict()

export const pluginReleaseSchema = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX_LENGTH).regex(PLUGIN_ID_PATTERN),
    version: z.string(),
    manifest: pluginManifestSchema,
    app: blobSchema,
    backend: blobSchema.optional(),
    storage: z.number().int().nonnegative(),
    tools: z.array(toolDeclarationSchema).max(64).refine((tools) => new Set(tools.map((tool) => tool.name)).size === tools.length, "tool names must be distinct").optional(),
    builtAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((release, context) => {
    if (Boolean(release.manifest.backend?.tools) !== Boolean(release.tools)) {
      context.addIssue({ code: "custom", path: ["tools"], message: "a release declares tools exactly when its manifest's backend declares a tool group" })
    }
    if (release.manifest.id !== release.id) context.addIssue({ code: "custom", path: ["manifest", "id"], message: `the manifest names ${release.manifest.id}, not ${release.id}` })
    if (release.manifest.version !== release.version) {
      context.addIssue({ code: "custom", path: ["manifest", "version"], message: `the manifest is version ${release.manifest.version}, not ${release.version}` })
    }
    if (Boolean(release.manifest.backend) !== Boolean(release.backend)) {
      context.addIssue({ code: "custom", path: ["backend"], message: "a release carries a backend bundle exactly when its manifest declares a backend" })
    }
  })

export const signedPluginReleaseSchema = z
  .object({ release: z.unknown(), signature: z.string().regex(SIGNATURE_PATTERN), keyId: z.string().regex(KEY_ID_PATTERN) })
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

export type SignedPayload = { payload: unknown; signature: string; keyId: string }

/** `schema`'s reading of a payload once its signature verifies under one of `keys`; `what` names the payload in a refusal. */
export async function verifySignedPayload<T>(signed: SignedPayload, keys: Readonly<Record<string, string>>, schema: z.ZodType<T>, what: string): Promise<T> {
  const publicKey = Object.hasOwn(keys, signed.keyId) ? keys[signed.keyId] : undefined
  if (!publicKey) throw new PluginReleaseError("release_key_unknown", `no registry key is named ${signed.keyId}`)
  const key = await crypto.subtle.importKey("raw", base64Bytes(publicKey), { name: "Ed25519" }, false, ["verify"])
  const valid = await crypto.subtle.verify("Ed25519", key, base64Bytes(signed.signature), pluginReleaseSigningBytes(signed.payload))
  if (!valid) throw new PluginReleaseError("release_signature_invalid", `the ${what}'s signature does not verify under ${signed.keyId}`)
  const parsed = schema.safeParse(signed.payload)
  if (parsed.success) return parsed.data
  throw new PluginReleaseError("release_malformed", parsed.error.issues.map((issue) => `${issue.path.join(".") || what}: ${issue.message}`).join("; "))
}

/**
 * The release `signed` carries, once its signature verifies under one of
 * `keys` and it parses as a release. The signature covers the release exactly
 * as published, before the manifest's defaults are filled in.
 */
export async function verifyPluginRelease(signed: unknown, keys: Readonly<Record<string, string>>): Promise<PluginRelease> {
  const envelope = signedPluginReleaseSchema.safeParse(signed)
  if (!envelope.success) throw new PluginReleaseError("release_malformed", "the release is not a signed release")
  const { release, signature, keyId } = envelope.data
  return verifySignedPayload({ payload: release, signature, keyId }, keys, pluginReleaseSchema, "release")
}
