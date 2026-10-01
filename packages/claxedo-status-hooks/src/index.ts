import { readPluginManifest, readStatusHookTemplates } from "@claxedo/plugin-api"
import packageJson from "../package.json"

const { statusHooks, ...manifest } = packageJson.claxedo

readPluginManifest({ claxedo: manifest })

export const firstPartyStatusHooks = readStatusHookTemplates(statusHooks)
