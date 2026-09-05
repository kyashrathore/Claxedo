import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentPluginMcpServer } from "@claxedo/server-core/agent-plugins/catalog/types"
import { pluginInstanceStorageKey } from "../plugin-data"
import type { AgentPluginHarnessProjectionAdapter, GenerationPluginRoot } from "./types"
import { projectedMcpServers } from "./mcp-projection"

const MARKETPLACE = "claxedo-agent-plugins"
const CACHE_MARKER = ".claxedo-agent-plugins.json"
const CONFIG_START = "# BEGIN CLAXEDO AGENT PLUGINS"
const CONFIG_END = "# END CLAXEDO AGENT PLUGINS"

function pluginVersion(version: string | undefined) {
  const result = version?.trim() || "1.0.0"
  if (!/^[A-Za-z0-9.+_-]+$/.test(result) || result === "." || result === "..") {
    throw new Error(`Codex cannot materialize plugin version ${JSON.stringify(result)}`)
  }
  return result
}

async function ownedCache(root: string) {
  try {
    const marker: unknown = JSON.parse(await fs.readFile(path.join(root, CACHE_MARKER), "utf8"))
    return marker !== null
      && typeof marker === "object"
      && "owner" in marker
      && marker.owner === "claxedo-agent-plugins"
      && "marketplace" in marker
      && marker.marketplace === MARKETPLACE
  } catch {
    return false
  }
}

async function updateCodexPluginConfig(codexHome: string, generationRoot: string, pluginNames: string[]) {
  const configFile = path.join(codexHome, "config.toml")
  const current = await fs.readFile(configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const start = current.indexOf(CONFIG_START)
  const end = current.indexOf(CONFIG_END)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Codex config ${configFile} contains a damaged Claxedo Agent Plugins block`)
  }
  const before = start === -1 ? current : current.slice(0, start)
  const after = start === -1 ? "" : current.slice(end + CONFIG_END.length)
  const unmanaged = `${before.trimEnd()}${after}`.trim()
  const managed = pluginNames.length ? [
    CONFIG_START,
    `[marketplaces.${MARKETPLACE}]`,
    'source_type = "local"',
    `source = ${JSON.stringify(generationRoot)}`,
    "",
    ...pluginNames.flatMap((name) => [
      `[plugins.${JSON.stringify(`${name}@${MARKETPLACE}`)}]`,
      "enabled = true",
      "",
    ]),
    CONFIG_END,
  ].join("\n") : ""
  const next = [unmanaged, managed].filter(Boolean).join("\n\n")
  const temporary = path.join(codexHome, `.config.toml.claxedo-${crypto.randomUUID()}`)
  await fs.writeFile(temporary, next ? `${next}\n` : "")
  await fs.rename(temporary, configFile)
}

function expand(value: string, pluginRoot: string, dataRoot: string) {
  return value
    .replaceAll("${PLUGIN_ROOT}", pluginRoot)
    .replaceAll("${PLUGIN_DATA}", dataRoot)
}

function codexMcpServer(
  server: AgentPluginMcpServer,
  pluginRoot: string,
  dataRoot: string,
) {
  if (server.type === "stdio") {
    return {
      command: expand(server.command, pluginRoot, dataRoot),
      ...(server.args ? { args: server.args.map((value) => expand(value, pluginRoot, dataRoot)) } : {}),
      ...(server.env ? {
        env: Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, expand(value, pluginRoot, dataRoot)])),
      } : {}),
      ...(server.cwd ? { cwd: expand(server.cwd, pluginRoot, dataRoot) } : {}),
    }
  }
  return {
    type: server.type === "streamable-http" ? "http" : "sse",
    url: server.url,
    ...(server.headers ? {
      headers: Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, expand(value, pluginRoot, dataRoot)])),
    } : {}),
  }
}

async function projectPlugin(
  viewRoot: string,
  plugin: GenerationPluginRoot,
  mcpServers: Parameters<typeof projectedMcpServers>[1],
) {
  const destination = path.join(
    viewRoot,
    `${plugin.plugin.manifest.name}-${pluginInstanceStorageKey(plugin.pluginInstanceId).slice(0, 12)}`,
  )
  await fs.cp(plugin.root, destination, { recursive: true, dereference: true, force: false, errorOnExist: true })
  const projected = projectedMcpServers(plugin, mcpServers)
  const codexManifestDirectory = path.join(destination, ".codex-plugin")
  await fs.mkdir(codexManifestDirectory, { recursive: true })
  await fs.writeFile(path.join(codexManifestDirectory, "plugin.json"), `${JSON.stringify({
    name: plugin.plugin.manifest.name,
    version: pluginVersion(plugin.plugin.manifest.version),
    ...(plugin.plugin.manifest.description ? { description: plugin.plugin.manifest.description } : {}),
    ...(plugin.plugin.skills.length ? { skills: "./skills/" } : {}),
    ...(plugin.plugin.mcp.status === "valid" && projected.length ? { mcpServers: "./.mcp.json" } : {}),
  }, null, 2)}\n`)
  if (plugin.plugin.mcp.status === "valid" && projected.length) {
    await fs.writeFile(path.join(destination, ".mcp.json"), `${JSON.stringify({
      mcpServers: Object.fromEntries(projected.map((server) => [
        server.name,
        codexMcpServer(server, destination, plugin.dataRoot),
      ])),
    }, null, 2)}\n`)
  }
  return destination
}

/** Generate a local Codex marketplace over the immutable retained generation. */
export function codexAgentPluginAdapter(input: { codexHome?: string } = {}): AgentPluginHarnessProjectionAdapter {
  const codexHome = input.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  const cacheRoot = path.join(codexHome, "plugins", "cache", MARKETPLACE)
  return {
    harnessId: "codex",
    projectEmpty: true,
    async project({ generationRoot, plugins, mcpServers = [] }) {
      const viewRoot = path.join(generationRoot, "harnesses", "codex", "plugins")
      await fs.mkdir(viewRoot, { recursive: true })
      const manifestDirectory = path.join(generationRoot, ".agents", "plugins")
      await fs.mkdir(manifestDirectory, { recursive: true })
      const names = new Set<string>()
      const codexPlugins: Array<{ plugin: GenerationPluginRoot; root: string }> = []
      for (const plugin of plugins) {
        const name = plugin.plugin.manifest.name
        if (names.has(name)) {
          throw new Error(`Codex cannot activate two plugins named ${JSON.stringify(name)} in one marketplace`)
        }
        names.add(name)
        codexPlugins.push({
          plugin,
          root: await projectPlugin(viewRoot, plugin, mcpServers),
        })
      }
      const entries = codexPlugins.map((projected) => ({
        name: projected.plugin.plugin.manifest.name,
        source: {
          source: "local",
          path: `./${path.relative(generationRoot, projected.root).split(path.sep).join("/")}`,
        },
      }))
      await fs.writeFile(path.join(manifestDirectory, "marketplace.json"), `${JSON.stringify({
        name: MARKETPLACE,
        plugins: entries,
      }, null, 2)}\n`)

      await fs.mkdir(codexHome, { recursive: true })
      const cacheExists = await fs.lstat(cacheRoot).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      })
      if (cacheExists && !(await ownedCache(cacheRoot))) {
        throw new Error(`Codex plugin cache ${cacheRoot} is not owned by Claxedo`)
      }
      const transaction = crypto.randomUUID()
      if (plugins.length === 0) {
        if (cacheExists) await fs.rm(cacheRoot, { recursive: true })
      } else {
        const stagingCache = path.join(path.dirname(cacheRoot), `.${MARKETPLACE}.staging-${transaction}`)
        const backupCache = path.join(path.dirname(cacheRoot), `.${MARKETPLACE}.backup-${transaction}`)
        await fs.mkdir(stagingCache, { recursive: true })
        let cacheActivated = false
        try {
          for (const projected of codexPlugins) {
            const version = pluginVersion(projected.plugin.plugin.manifest.version)
            const destination = path.join(stagingCache, projected.plugin.plugin.manifest.name, version)
            await fs.mkdir(path.dirname(destination), { recursive: true })
            await fs.cp(projected.root, destination, { recursive: true, dereference: true, force: false, errorOnExist: true })
          }
          await fs.writeFile(path.join(stagingCache, CACHE_MARKER), `${JSON.stringify({
            owner: "claxedo-agent-plugins",
            marketplace: MARKETPLACE,
          }, null, 2)}\n`)
          if (cacheExists) await fs.rename(cacheRoot, backupCache)
          await fs.rename(stagingCache, cacheRoot)
          cacheActivated = true
          await fs.rm(backupCache, { recursive: true, force: true }).catch(() => undefined)
        } catch (error) {
          await fs.rm(stagingCache, { recursive: true, force: true })
          if (cacheActivated) await fs.rm(cacheRoot, { recursive: true, force: true })
          if (await fs.lstat(backupCache).then(() => true, () => false)) {
            await fs.rename(backupCache, cacheRoot).catch(() => undefined)
          }
          throw error
        }
      }
      await updateCodexPluginConfig(
        codexHome,
        generationRoot,
        codexPlugins.map((plugin) => plugin.plugin.plugin.manifest.name),
      )
      const configFile = path.join(generationRoot, "harnesses", "codex", "launch.json")
      await fs.mkdir(path.dirname(configFile), { recursive: true })
      await fs.writeFile(configFile, `${JSON.stringify((plugins.length ? {
          marketplace: {
            name: MARKETPLACE,
            source: generationRoot,
          },
          plugins: codexPlugins.map((plugin) => `${plugin.plugin.plugin.manifest.name}@${MARKETPLACE}`),
        } : {}), null, 2)}\n`)
      return {
        harnessId: "codex",
        configFile,
        pluginRoots: codexPlugins.map((projected) => ({
          pluginInstanceId: projected.plugin.pluginInstanceId,
          root: projected.root,
          dataRoot: projected.plugin.dataRoot,
        })),
        diagnostics: [],
      }
    },
  }
}
