import { readPluginManifest } from "@claxedo/plugin-api/manifest"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import firstParty from "@claxedo/status-hooks/manifest"

export const defaultStatusHooks: readonly StatusHookTemplate[] = readPluginManifest(firstParty).statusHooks!

export const defaultGenericWrappers = ["aider", "goose", "cline"]
