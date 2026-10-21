import { readToolCardTemplates, ToolCardTemplateError } from "@claxedo/plugin-api"
import { PluginEntryError } from "./services"
import type { ToolCardIntake } from "./tool-card-intake"

export const checkToolCards: ToolCardIntake = (pluginId, templates) => {
  try {
    return readToolCardTemplates(templates)
  } catch (error) {
    if (error instanceof ToolCardTemplateError) throw new PluginEntryError(pluginId, error.message)
    throw error
  }
}
