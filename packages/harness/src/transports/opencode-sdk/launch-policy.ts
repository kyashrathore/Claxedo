import type { Mcp, Plugin, Skill } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
import { createKeyedSerializer } from "@claxedo/helpers"
import { openCodeLocationClient, type OpenCodeHost } from "./host.js"
import type { WorkspaceScope } from "./scope.js"
import { loadSkills } from "./skill-info.js"

export type OpenCodeLaunchDocument = Readonly<{

  skills: readonly string[]

  mcp: Readonly<Record<string, Mcp.ServerConfig>>
}>

export type LaunchPolicyStore = Readonly<{

  read(): Promise<OpenCodeLaunchDocument>

  write(document: OpenCodeLaunchDocument): Promise<void>
}>

const EMPTY: OpenCodeLaunchDocument = Object.freeze({ skills: Object.freeze([]), mcp: Object.freeze({}) })

async function setupLaunchPolicy(context: Plugin.Context, stores: Map<string, LaunchPolicyStore>) {
  let document = EMPTY
  let skills: Skill.Info[] = []
  const serializer = createKeyedSerializer()
  const key = context.location.directory
  await context.mcp.transform((draft) => {
    for (const [name, config] of Object.entries(document.mcp)) draft.set(name, config)
  })
  await context.skill.transform((draft) => {
    for (const skill of skills) draft.add(skill)
  })
  const store: LaunchPolicyStore = {
    read: () => serializer.run(key, async () => document),
    write: (next) => serializer.run(key, async () => {
      const loaded = await loadSkills(next.skills)
      document = { skills: [...next.skills], mcp: { ...next.mcp } }
      skills = loaded
      await context.mcp.reload()
      await context.skill.reload()
    }),
  }
  stores.set(key, store)
  return () => {
    if (stores.get(key) === store) stores.delete(key)
  }
}

export function createLaunchPolicy() {
  const stores = new Map<string, LaunchPolicyStore>()
  const plugin: Plugin.Plugin = {
    id: "claxedo-launch-policy",
    setup: (context) => setupLaunchPolicy(context, stores),
  }
  return {
    plugin,
    async store(host: OpenCodeHost, scope: WorkspaceScope): Promise<LaunchPolicyStore> {

      await openCodeLocationClient(host, scope.directory)
      const store = stores.get(await fs.realpath(scope.directory)) ?? stores.get(scope.directory)
      if (!store) throw new Error("OpenCode launch policy was not initialized for the workspace")
      return store
    },
  }
}
