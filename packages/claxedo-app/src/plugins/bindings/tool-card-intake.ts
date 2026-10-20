import type { ToolCardTemplate } from "@claxedo/plugin-api"
import { loadChunk } from "@/lib/lazy-view"
import type { PluginOrigin } from "../model"

export type ToolCardIntake = (pluginId: string, templates: readonly ToolCardTemplate[]) => readonly ToolCardTemplate[]

const shippedToolCards: ToolCardIntake = (_pluginId, templates) => templates

export function loadToolCardIntake(origin: PluginOrigin): Promise<ToolCardIntake> {
  if (origin.kind === "bundled") return Promise.resolve(shippedToolCards)
  return loadChunk(() => import("./tool-card-check")).then((module) => module.checkToolCards)
}
