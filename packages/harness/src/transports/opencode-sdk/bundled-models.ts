import type { ProviderModel } from "../../contract"
import { BUNDLED_MODELS } from "./bundled-models.generated.js"

export function openCodeBundledModels(providerIDs: readonly string[]): ProviderModel[] {
  return providerIDs.flatMap((providerID) => (BUNDLED_MODELS[providerID] ?? []).map(([id, name, variants]) => ({
    providerID, id, name, ...(variants.length ? { variants: [...variants] } : {}), cost: [],
  })))
}
