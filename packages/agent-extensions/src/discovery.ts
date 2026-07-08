import fs from "fs/promises"
import path from "path"
import type { HarnessTarget } from "./types"

export type AgentHookComponentRunner = HarnessTarget | "droid" | "gemini" | "mastra"

export type DiscoveredAgentExtensionComponent =
  | {
      type: "skill"
      name: string
      path: string
    }
  | {
      type: "mcp"
      name: string
      path: string
    }
  | {
      type: "plugin"
      runner: Extract<HarnessTarget, "cursor">
      name: string
      path: string
    }
  | {
      type: "hook"
      runner: AgentHookComponentRunner
      name: string
      path: string
    }

async function fileExists(file: string) {
  return fs.stat(file).then((item) => item.isFile()).catch(() => false)
}

async function dirExists(dir: string) {
  return fs.stat(dir).then((item) => item.isDirectory()).catch(() => false)
}

async function readDir(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [])
}

function componentName(fileOrDir: string) {
  const base = path.basename(fileOrDir)
  const ext = path.extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

async function pluginName(file: string, fallback: string) {
  const manifest = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
  return typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : fallback
}

async function discoverSkills(root: string) {
  const skillsDir = path.join(root, "skills")
  const conventional = (await Promise.all((await readDir(skillsDir))
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<DiscoveredAgentExtensionComponent[]> => {
      const skillDir = path.join(skillsDir, entry.name)
      if (!await fileExists(path.join(skillDir, "SKILL.md"))) return []
      return [{ type: "skill" as const, name: entry.name, path: skillDir }]
    }))).flat()

  if (conventional.length > 0) return conventional
  if (!await fileExists(path.join(root, "SKILL.md"))) return []
  return [{ type: "skill" as const, name: path.basename(root), path: root }]
}

async function discoverMcp(root: string) {
  const mcpDir = path.join(root, "mcp")
  const conventional = (await readDir(mcpDir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      type: "mcp" as const,
      name: componentName(entry.name),
      path: path.join(mcpDir, entry.name),
    }))

  if (conventional.length > 0) return conventional
  if (await fileExists(path.join(root, "mcp.json"))) {
    return [{ type: "mcp" as const, name: path.basename(root), path: path.join(root, "mcp.json") }]
  }
  if (await fileExists(path.join(root, ".vscode", "mcp.json"))) {
    return [{ type: "mcp" as const, name: path.basename(root), path: path.join(root, ".vscode", "mcp.json") }]
  }
  return []
}

async function discoverCursorPlugins(root: string) {
  const pluginsDir = path.join(root, "plugins", "cursor")
  const nested = (await Promise.all((await readDir(pluginsDir))
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<DiscoveredAgentExtensionComponent[]> => {
      const pluginDir = path.join(pluginsDir, entry.name)
      if (!await fileExists(path.join(pluginDir, "plugin.json"))) return []
      return [{ type: "plugin", runner: "cursor", name: entry.name, path: pluginDir }]
    }))).flat()

  if (nested.length > 0) return nested
  const conventionalPlugin = path.join(pluginsDir, "plugin.json")
  if (await fileExists(conventionalPlugin)) {
    return [{
      type: "plugin" as const,
      runner: "cursor" as const,
      name: await pluginName(conventionalPlugin, path.basename(root)),
      path: pluginsDir,
    }]
  }
  const legacyPlugin = path.join(root, ".cursor-plugin", "plugin.json")
  if (await fileExists(legacyPlugin)) {
    return [{
      type: "plugin" as const,
      runner: "cursor" as const,
      name: await pluginName(legacyPlugin, path.basename(root)),
      path: root,
    }]
  }
  return []
}

function hookRunner(name: string): AgentHookComponentRunner | undefined {
  if (name === "claude" || name === "codex" || name === "cursor" || name === "opencode") return name
  if (name === "droid" || name === "gemini" || name === "mastra") return name
  return undefined
}

async function discoverHooks(root: string) {
  const hooksDir = path.join(root, "hooks")
  return (await readDir(hooksDir)).flatMap((entry): DiscoveredAgentExtensionComponent[] => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return []
    const name = componentName(entry.name)
    const runner = hookRunner(name)
    if (!runner) return []
    return [{ type: "hook", runner, name, path: path.join(hooksDir, entry.name) }]
  })
}

export async function discoverAgentExtensionComponents(root: string) {
  if (!await dirExists(root)) return []
  return [
    ...await discoverSkills(root),
    ...await discoverMcp(root),
    ...await discoverCursorPlugins(root),
    ...await discoverHooks(root),
  ]
}
