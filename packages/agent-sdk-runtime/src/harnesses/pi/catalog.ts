import { pathToFileURL } from "node:url"
import path from "node:path"
import { asRecord, isRecord } from "@claxedo/agent-runtime-contract"
import { piPackageRoot } from "./executable"
import type { SdkModelEntry } from "../../sdk-model-options"

type PiModelRuntimeModule = {
  ModelRuntime: { create(options: Record<string, unknown>): Promise<{ getModels(): unknown }> }
}

/** `ModelRuntime` is a class, so it is a callable, not a record. */
function isPiModelRuntimeModule(value: unknown): value is PiModelRuntimeModule {
  if (!isRecord(value)) return false
  const runtime = value.ModelRuntime
  if (runtime === null || (typeof runtime !== "object" && typeof runtime !== "function")) return false
  return typeof Reflect.get(runtime, "create") === "function"
}

/**
 * `get_available_models` is auth-filtered. Pi's `ModelRuntime.getModels()` is
 * the credential-blind catalog from the same package as the pinned binary.
 */
export async function listPiCatalogModels(binary: string, agentDir: string): Promise<SdkModelEntry[]> {
  const root = piPackageRoot(binary)
  if (!root) return []
  try {
    const loaded: unknown = await import(pathToFileURL(path.join(root, "dist/core/model-runtime.js")).href)
    if (!isPiModelRuntimeModule(loaded)) return []
    const runtime = await loaded.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    const models = runtime.getModels()
    if (!Array.isArray(models)) return []
    return models.flatMap((value) => {
      const model = asRecord(value)
      const provider = typeof model?.provider === "string" ? model.provider : ""
      const id = typeof model?.id === "string" ? model.id : ""
      if (!provider || !id) return []
      return [{ id: `${provider}/${id}`, name: typeof model?.name === "string" && model.name ? model.name : id }]
    })
  } catch {
    return []
  }
}
