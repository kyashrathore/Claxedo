import { configOptionsPreview } from "../../contract"
import { CLAUDE_BUNDLED_MODELS } from "./bundled-models.generated.js"
import { modelOptions } from "./model-options"

export type ClaudeAccountForm = "api" | "plan"

export function claudeBundledOptions(form: ClaudeAccountForm, model?: string) {
  return configOptionsPreview(modelOptions(CLAUDE_BUNDLED_MODELS[form], model ?? "default"))
}
