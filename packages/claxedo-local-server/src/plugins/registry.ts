import path from "node:path"
import { z } from "zod"
import { PLUGIN_ID_PATTERN } from "@claxedo/plugin-api"
import { LivePluginStoreError, readJsonFileIfPresent, writeJsonFileAtomically } from "./store"

const entrySchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN),
    directory: z.string().min(1),
    addedAt: z.string().min(1),
  })
  .strict()

const registrySchema = z.object({ version: z.literal(1), plugins: z.array(entrySchema) }).strict()

export type LivePluginRegistryEntry = z.infer<typeof entrySchema>

export function livePluginRegistryFile(root: string): string {
  return path.join(root, "registry.json")
}

export async function readLivePluginRegistry(root: string): Promise<LivePluginRegistryEntry[]> {
  const file = livePluginRegistryFile(root)
  const raw = await readJsonFileIfPresent(file)
  if (raw === undefined) return []
  const parsed = registrySchema.safeParse(raw)
  if (parsed.success) return parsed.data.plugins
  throw new LivePluginStoreError(file, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
}

export async function writeLivePluginRegistry(root: string, entries: readonly LivePluginRegistryEntry[]): Promise<void> {
  await writeJsonFileAtomically(livePluginRegistryFile(root), { version: 1, plugins: entries })
}
