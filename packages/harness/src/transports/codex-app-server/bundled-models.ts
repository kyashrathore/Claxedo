import { configOptionsPreview } from "../../contract"
import { CODEX_BUNDLED_MODELS } from "./bundled-models.generated.js"
import { codexModelOptions } from "./models"

export function codexBundledOptions(model?: string) {
  return configOptionsPreview(codexModelOptions(CODEX_BUNDLED_MODELS, model))
}
