import type { Mcp, Plugin, Skill } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
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
      let pending = Promise.resolve()

      await context.mcp.transform((draft) => {
        for (const [name, config] of Object.entries(document.mcp)) draft.set(name, config)
      })
      await context.skill.transform((draft) => {
        for (const skill of skills) draft.add(skill)
      })
      const store: LaunchPolicyStore = {
        async read() {
          await pending
          return document
        },
        async write(next) {
          const operation = pending.then(async () => {
            const loaded = await loadSkills(next.skills)
            document = { skills: [...next.skills], mcp: { ...next.mcp } }
            skills = loaded
            await context.mcp.reload()
            await context.skill.reload()
          })
          pending = operation.catch((error: unknown) => {
            console.error("OpenCode launch policy write failed", error)
          })
          await operation
        },
      }
      stores.set(context.location.directory, store)
      return () => {
        if (stores.get(context.location.directory) === store) stores.delete(context.location.directory)
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
