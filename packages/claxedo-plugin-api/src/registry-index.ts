import { z } from "zod"
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from "./id"
import { PLUGIN_NAME_MAX_LENGTH, type PluginManifest } from "./manifest"
import { pluginManifestSchema, PLUGIN_VERSION_PATTERN } from "./manifest-schema"
import { KEY_ID_PATTERN, PluginReleaseError, SIGNATURE_PATTERN, verifySignedPayload } from "./release"

export const PLUGIN_INDEX_DESCRIPTION_MAX_LENGTH = 280

/** One plugin the registry lists: its published versions, newest first, and the manifest of `latest`. */
export type PluginIndexEntry = {
  id: string
  name: string
  description?: string | undefined
  latest: string
  versions: string[]
  manifest: PluginManifest
}

/** The registry's `index.json`: every plugin it publishes. */
export type PluginIndex = { entries: PluginIndexEntry[]; builtAt: string }

export type SignedPluginIndex = { index: PluginIndex; signature: string; keyId: string }

const indexEntrySchema = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX_LENGTH).regex(PLUGIN_ID_PATTERN),
    name: z.string().trim().min(1).max(PLUGIN_NAME_MAX_LENGTH),
    description: z.string().max(PLUGIN_INDEX_DESCRIPTION_MAX_LENGTH).optional(),
    latest: z.string().regex(PLUGIN_VERSION_PATTERN),
    versions: z.array(z.string().regex(PLUGIN_VERSION_PATTERN)).min(1),
    manifest: pluginManifestSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.manifest.id !== entry.id || entry.manifest.version !== entry.latest) {
      context.addIssue({ code: "custom", path: ["manifest"], message: `the manifest is ${entry.manifest.id} ${entry.manifest.version}, not ${entry.id} ${entry.latest}` })
    }
    if (!entry.versions.includes(entry.latest)) context.addIssue({ code: "custom", path: ["versions"], message: `${entry.latest} is not among the published versions` })
  })

export const pluginIndexSchema = z
  .object({ entries: z.array(indexEntrySchema), builtAt: z.iso.datetime() })
  .strict()
  .superRefine((index, context) => {
    const ids = index.entries.map((entry) => entry.id)
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["entries"], message: "the index lists a plugin twice" })
  })

export const signedPluginIndexSchema = z
  .object({ index: z.unknown(), signature: z.string().regex(SIGNATURE_PATTERN), keyId: z.string().regex(KEY_ID_PATTERN) })
  .strict()

/** The index `signed` carries, once its signature verifies under one of `keys` and it parses as an index. */
export async function verifyPluginIndex(signed: unknown, keys: Readonly<Record<string, string>>): Promise<PluginIndex> {
  const envelope = signedPluginIndexSchema.safeParse(signed)
  if (!envelope.success) throw new PluginReleaseError("release_malformed", "the index is not a signed index")
  const { index, signature, keyId } = envelope.data
  return verifySignedPayload({ payload: index, signature, keyId }, keys, pluginIndexSchema, "index")
}
