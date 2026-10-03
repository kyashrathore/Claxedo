import type { Mcp, Plugin, Skill } from "@opencode-ai/plugin"
import { watchMcpSettle } from "./mcp-settle.js"
import { loadSkills } from "./skill-info.js"

export type OpenCodeLaunchDocument = Readonly<{
  skills: readonly Skill.Info[]
  mcp: Readonly<Record<string, Mcp.ServerConfig>>
}>

export async function loadLaunchDocument(input: {
  skills: readonly string[]
  mcp: Readonly<Record<string, Mcp.ServerConfig>>
}): Promise<OpenCodeLaunchDocument> {
  return { skills: await loadSkills(input.skills), mcp: { ...input.mcp } }
}

export function launchPolicyPlugin(document: OpenCodeLaunchDocument, settling: (ready: Promise<void>) => void): Plugin.Plugin {
  return {
    id: "claxedo-launch-policy",
    async setup(context) {
      await context.skill.transform((draft) => {
        for (const skill of document.skills) draft.add(skill)
      })
      const servers = Object.entries(document.mcp).filter(([, config]) => config.disabled !== true).map(([name]) => name)
      const settle = await watchMcpSettle(context, servers)
      settling(settle.ready)
      await context.mcp.transform((draft) => {
        for (const [name, config] of Object.entries(document.mcp)) draft.set(name, config)
      })
      return () => settle.close()
    },
  }
}
