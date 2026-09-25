import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { pluginManifestSchema } from "@claxedo/plugin-api"
import { PLUGIN_BUNDLE_HASH_LENGTH } from "@claxedo/plugin-build"
import type { LivePluginBundle } from "./machine"
import { isMissingFile, LivePluginStoreError, readJsonFile, writeJsonFileAtomically } from "./store"

export const BUNDLE_HASH_PATTERN = new RegExp(`^[0-9a-f]{${PLUGIN_BUNDLE_HASH_LENGTH}}$`)

const currentSchema = z
  .object({
    hash: z.string().regex(BUNDLE_HASH_PATTERN),
    manifest: pluginManifestSchema,
    builtAt: z.iso.datetime(),
  })
  .strict()

export function livePluginBundlesDirectory(root: string, id: string): string {
  return path.join(root, "bundles", id)
}

function currentFile(root: string, id: string): string {
  return path.join(livePluginBundlesDirectory(root, id), "current.json")
}

export async function saveLivePluginBundle(root: string, id: string, bundle: LivePluginBundle & { code: string }): Promise<void> {
  const directory = path.join(livePluginBundlesDirectory(root, id), bundle.hash)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "app.js"), bundle.code)
  await writeJsonFileAtomically(currentFile(root, id), { hash: bundle.hash, manifest: bundle.manifest, builtAt: bundle.builtAt })
}

export async function readLivePluginBundle(root: string, id: string, hash: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(livePluginBundlesDirectory(root, id), hash, "app.js"), "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

export async function readCurrentLivePluginBundle(root: string, id: string): Promise<LivePluginBundle | undefined> {
  const file = currentFile(root, id)
  const raw = await readJsonFile(file)
  if (raw === undefined) return undefined
  const parsed = currentSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  throw new LivePluginStoreError(file, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
}

export async function removeLivePluginBundles(root: string, id: string): Promise<void> {
  await fs.rm(livePluginBundlesDirectory(root, id), { recursive: true, force: true })
}
