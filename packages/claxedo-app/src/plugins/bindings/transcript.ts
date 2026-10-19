import { readToolCardTemplates, ToolCardTemplateError, type PluginApi, type ToolCardTemplate } from "@claxedo/plugin-api"
import { fillPattern, type ToolCardEntry } from "@/shell"
import { entryId, pageEntryFor, PluginEntryError, type BindingScope } from "./services"

function templatesOf(scope: BindingScope, value: unknown): readonly ToolCardTemplate[] {
  try {
    return readToolCardTemplates(value)
  } catch (error) {
    if (error instanceof ToolCardTemplateError) throw new PluginEntryError(scope.manifest.id, error.message)
    throw error
  }
}

function refuseTakenTools(scope: BindingScope, templates: readonly ToolCardTemplate[]): void {
  const taken = new Set(scope.services.registries.toolCards.list().map((entry) => entry.template.tool))
  for (const template of templates) {
    if (taken.has(template.tool)) throw new PluginEntryError(scope.manifest.id, `the tool ${template.tool} already has a card template`)
    taken.add(template.tool)
  }
}

function toolCardEntry(scope: BindingScope, template: ToolCardTemplate): ToolCardEntry {
  return {
    id: entryId(scope.manifest.id, template.tool),
    template,
    pageHref: (pageId, params) => {
      const page = pageEntryFor(scope, pageId)
      return page ? fillPattern(page.path, params) : undefined
    },
  }
}

export function transcriptBinding(scope: BindingScope): PluginApi["transcript"] {
  return {
    toolCards: (value) => {
      const templates = templatesOf(scope, value)
      refuseTakenTools(scope, templates)
      const disposers = templates.map((template) => scope.sink.add(scope.services.registries.toolCards, toolCardEntry(scope, template)))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  }
}
