import type { Mcp, Plugin, Skill } from "@opencode-ai/plugin"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { OpenCodeHost } from "./host"
import type { WorkspaceScope } from "./scope"

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

/**
 * Agent Plugins lay skills out as `<directory>/<skill>/SKILL.md`, the same
 * layout the engine scans for a config `skills` entry. The frontmatter's
 * `name` and `description` are the fields the engine reads; everything after
 * the frontmatter is the skill body.
 */
async function loadSkills(directories: readonly string[]): Promise<Skill.Info[]> {
  const skills = new Map<string, Skill.Info>()
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      const location = path.join(directory, entry.name, "SKILL.md")
      const text = await fs.readFile(location, "utf8").catch(() => undefined)
      if (text === undefined) continue
      skills.set(entry.name, parseSkill(entry.name, location, text))
    }
  }
  return [...skills.values()]
}

export function parseSkill(id: string, location: string, text: string): Skill.Info {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const frontmatter: Record<string, string> = {}
  for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) frontmatter[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/, "$2")
  }
  return {
    id,
    name: frontmatter.name || id,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    location,
    content: match ? match[2] : text,
  } as Skill.Info
}
