import fs from "node:fs/promises"
import path from "node:path"
import { directTransport, type HttpTransport } from "../../../harness/e2e/harness/transport"

export type LivePluginFolder = {
  id: string
  name: string
  version?: string
  routes?: readonly string[]
  operations?: readonly string[]
  requires?: readonly string[]
  app: string
}

export type LivePluginRow = {
  id: string
  status: string
  hash: string | null
  builtAt: string | null
  manifest: { server: { routes: string[] } } | null
  lastError: string | null
}

const LIVE_PLUGINS_PATH = "/api/claxedo/live-plugins"

export async function writeLivePlugin(directory: string, plugin: LivePluginFolder) {
  await fs.mkdir(path.join(directory, "src"), { recursive: true })
  const manifest = {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version ?? "0.1.0",
    app: "./src/app.tsx",
    requires: plugin.requires ?? [],
    server: { routes: plugin.routes ?? [], operations: plugin.operations ?? [] },
  }
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: `claxedo-plugin-${plugin.id}`, version: manifest.version, type: "module", claxedo: manifest }, null, 2))
  await fs.writeFile(path.join(directory, "src", "app.tsx"), plugin.app)
  return directory
}

export async function registerLivePlugin(serverUrl: string, directory: string, transport: HttpTransport = directTransport): Promise<LivePluginRow> {
  const reply = await transport({ method: "POST", url: new URL(LIVE_PLUGINS_PATH, serverUrl).href, headers: { "content-type": "application/json" }, body: JSON.stringify({ directory }) })
  if (reply.status !== 201) throw new Error(`Registering ${directory} answered ${reply.status}: ${reply.body}`)
  return JSON.parse(reply.body) as LivePluginRow
}

export async function listLivePlugins(serverUrl: string, transport: HttpTransport = directTransport): Promise<{ status: number; plugins: LivePluginRow[] }> {
  const reply = await transport({ method: "GET", url: new URL(LIVE_PLUGINS_PATH, serverUrl).href })
  if (reply.status !== 200) return { status: reply.status, plugins: [] }
  return { status: 200, plugins: (JSON.parse(reply.body) as { plugins: LivePluginRow[] }).plugins }
}
