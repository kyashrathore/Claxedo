import type { Mcp, Plugin, Skill } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
import type { OpenCodeHost } from "./host"
import type { WorkspaceScope } from "./scope"
import { loadSkills } from "./skill-info"

/**
 * The launch document of ONE workspace inside the OpenCode harness: the
 * skill directories and MCP servers Claxedo wants the engine to expose for
 * that workspace. It is the projection of two Claxedo-owned inputs — the
 * runtime snapshot's MCP servers and Agent Plugins' OpenCode config
 * (`harnessLaunch.opencode.config`) — into the embedded SDK's own shapes.
 */
export type OpenCodeLaunchDocument = Readonly<{
  /** Skill directories, each holding `<skill>/SKILL.md` entries. */
  skills: readonly string[]
  /** MCP servers in the SDK's config shape, keyed by server name. */
  mcp: Readonly<Record<string, Mcp.ServerConfig>>
}>

export type LaunchPolicyStore = Readonly<{
  /** The document last applied to this workspace. */
  read(): Promise<OpenCodeLaunchDocument>
  /**
   * Replace the document and settle the engine's per-workspace skill and MCP
   * registries so the next turn sees exactly this set. A write that fails is
   * returned to the caller; the previous document stays applied.
   */
  write(document: OpenCodeLaunchDocument): Promise<void>
}>

const EMPTY: OpenCodeLaunchDocument = Object.freeze({ skills: Object.freeze([]), mcp: Object.freeze({}) })

/**
 * Workspace launch options are enforced in the engine's own skill and MCP
 * registries through the SDK plugin surface, per location — never by writing
 * `opencode.json` into the user's project or global configuration. The
 * document is process state: the host re-applies the snapshot on restart.
 */
export function createLaunchPolicy() {
  const stores = new Map<string, LaunchPolicyStore>()
  const plugin: Plugin.Plugin = {
    id: "claxedo-launch-policy",
    async setup(context) {
      let document = EMPTY
      let skills: Skill.Info[] = []
      let pending = Promise.resolve()
      // Transforms read the live closure state; `reload()` re-runs them, which
      // is how a write becomes visible without re-registering anything.
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
          pending = operation.catch(() => {})
          await operation
        },
      }
      stores.set(context.location.directory, store)
      return () => {
        if (stores.get(context.location.directory) === store) stores.delete(context.location.directory)
      }
    },
  }
  return {
    plugin,
    async store(host: OpenCodeHost, scope: WorkspaceScope): Promise<LaunchPolicyStore> {
      // Plugins set up per location on that location's first use. The engine
      // keys locations by real path, so a symlinked workspace directory still
      // resolves to the one store its plugin instance registered.
      await (await host.client()).model.list({ location: { directory: scope.directory } })
      const store = stores.get(await fs.realpath(scope.directory).catch(() => scope.directory)) ?? stores.get(scope.directory)
      if (!store) throw new Error("OpenCode launch policy was not initialized for the workspace")
      return store
    },
  }
}
