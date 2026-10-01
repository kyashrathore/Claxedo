import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { firstPartyStatusHooks } from "@claxedo/status-hooks"

export const defaultStatusHooks: readonly StatusHookTemplate[] = firstPartyStatusHooks

export const defaultGenericWrappers = ["aider", "goose", "cline"]
