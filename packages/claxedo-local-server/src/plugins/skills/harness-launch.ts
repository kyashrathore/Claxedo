import path from "node:path"
import { fileURLToPath } from "node:url"
import { isRecord } from "../../platform/json"

export const CLAXEDO_PLUGIN_AUTHORING_SKILL = "claxedo-plugin-authoring"

export const LIVE_PLUGIN_SKILLS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))

export type HarnessLaunch = Record<string, Record<string, unknown>>

export function withLivePluginSkills(launch: HarnessLaunch, skillsDirectory = LIVE_PLUGIN_SKILLS_DIRECTORY): HarnessLaunch {
  const opencode = launch.opencode ?? {}
  const config = isRecord(opencode.config) ? opencode.config : {}
  const skills = Array.isArray(config.skills) ? config.skills : []
  if (skills.includes(skillsDirectory)) return launch
  return { ...launch, opencode: { ...opencode, config: { ...config, skills: [...skills, skillsDirectory] } } }
}
