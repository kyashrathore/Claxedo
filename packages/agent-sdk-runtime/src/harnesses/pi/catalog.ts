import { pathToFileURL } from "node:url"
import path from "node:path"
import { piPackageRoot } from "./executable"
import type { SdkModelEntry } from "../../sdk-model-options"

/**
 * `get_available_models` is auth-filtered. Pi's `ModelRuntime.getModels()` is
 * the credential-blind catalog from the same package as the pinned binary.
 */
export async function listPiCatalogModels(binary: string, agentDir: string): Promise<SdkModelEntry[]> {
  const root = piPackageRoot(binary)
  if (!root) return []
  try {
    const loaded = (await import(pathToFileURL(path.join(root, "dist/core/model-runtime.js")).href)) as {
      ModelRuntime?: { create(options: Record<string, unknown>): Promise<{ getModels(): unknown }> }
    }
    if (typeof loaded.ModelRuntime?.create !== "function") return []
    const runtime = await loaded.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    const models = runtime.getModels()
    if (!Array.isArray(models)) return []
    return models.flatMap((value) => {
      const model = value && typeof value === "object" ? (value as { provider?: unknown; id?: unknown; name?: unknown }) : undefined
      const provider = typeof model?.provider === "string" ? model.provider : ""
      const id = typeof model?.id === "string" ? model.id : ""
      if (!provider || !id) return []
      return [{ id: `${provider}/${id}`, name: typeof model?.name === "string" && model.name ? model.name : id }]
    })
  } catch {
    return []
  }
}
