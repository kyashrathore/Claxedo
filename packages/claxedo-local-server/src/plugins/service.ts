import fs from "node:fs/promises"
import path from "node:path"
import { buildPluginApp, PluginBuildError, readPluginPackage, watchPluginFolder, type PluginFolderWatch } from "@claxedo/plugin-build"
import { controlBus, type PluginsChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { readCurrentLivePluginBundle, readLivePluginBundle, removeLivePluginBundles, saveLivePluginBundle } from "./bundles"
import { initialLivePluginState, servedBundle, transitionLivePlugin, type LivePluginEvent, type LivePluginState } from "./machine"
import { readLivePluginRegistry, writeLivePluginRegistry, type LivePluginRegistryEntry } from "./registry"

export const LIVE_PLUGINS_ROUTE_PATH = "/api/claxedo/live-plugins"

const log = Log.create({ service: "live-plugins" })

export type LivePluginRow = {
  id: string
  name: string | null
  version: string | null
  directory: string
  status: LivePluginState["kind"]
  hash: string | null
  url: string | null
  lastError: string | null
}

export class LivePluginAddError extends Error {
  readonly status: 400 | 404 | 409
  readonly code: string

  constructor(status: 400 | 404 | 409, code: string, message: string) {
    super(message)
    this.name = "LivePluginAddError"
    this.status = status
    this.code = code
  }
}

export type LivePluginService = {
  ready: Promise<void>
  list(): LivePluginRow[]
  add(directory: string): Promise<LivePluginRow>
  remove(id: string): Promise<boolean>
  bundle(id: string, hash: string): Promise<string | undefined>
  settled(): Promise<void>
  dispose(): void
}

type LivePluginRecord = {
  entry: LivePluginRegistryEntry
  name: string | null
  version: string | null
  state: LivePluginState
  watch?: PluginFolderWatch
  queue: Promise<void>
}

export type LivePluginServiceOptions = {
  root: string
  publish?: (event: PluginsChangedEvent) => void
}

function bundleUrl(id: string, hash: string): string {
  return `${LIVE_PLUGINS_ROUTE_PATH}/${encodeURIComponent(id)}/${hash}/app.js`
}

function row(record: LivePluginRecord): LivePluginRow {
  const bundle = servedBundle(record.state)
  return {
    id: record.entry.id,
    name: record.name,
    version: record.version,
    directory: record.entry.directory,
    status: record.state.kind,
    hash: bundle?.hash ?? null,
    url: bundle ? bundleUrl(record.entry.id, bundle.hash) : null,
    lastError: record.state.kind === "failed" ? record.state.error : null,
  }
}

async function existingDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new LivePluginAddError(400, "live_plugin_directory_relative", "A plugin folder is registered by its absolute path")
  }
  let stat
  try {
    stat = await fs.stat(directory)
  } catch {
    throw new LivePluginAddError(404, "live_plugin_directory_missing", `${directory} does not exist on this machine`)
  }
  if (!stat.isDirectory()) throw new LivePluginAddError(400, "live_plugin_directory_not_a_directory", `${directory} is not a folder`)
  return fs.realpath(directory)
}

export function createLivePluginService(options: LivePluginServiceOptions): LivePluginService {
  const { root } = options
  const publish = options.publish ?? (() => undefined)
  const plugins = new Map<string, LivePluginRecord>()

  const apply = (record: LivePluginRecord, event: LivePluginEvent) => {
    record.state = transitionLivePlugin(record.state, event)
    const bundle = servedBundle(record.state)
    publish({ type: "plugins.changed", pluginId: record.entry.id, status: record.state.kind, ...(bundle ? { hash: bundle.hash } : {}), ts: Date.now() })
  }

  const runBuild = async (record: LivePluginRecord) => {
    apply(record, { type: "buildStarted" })
    try {
      const built = await buildPluginApp({ rootDir: record.entry.directory })
      if (built.manifest.id !== record.entry.id) {
        throw new PluginBuildError("manifest", [
          `${record.entry.directory}: the manifest id changed from ${record.entry.id} to ${built.manifest.id}; remove the folder and add it again`,
        ])
      }
      const bundle = { hash: built.hash, name: built.manifest.name, version: built.manifest.version }
      await saveLivePluginBundle(root, record.entry.id, { ...bundle, code: built.code })
      record.name = bundle.name
      record.version = bundle.version
      apply(record, { type: "buildSucceeded", bundle })
    } catch (error) {
      if (!(error instanceof PluginBuildError)) log.error("live plugin build failed outside the bundler", { id: record.entry.id, error: String(error) })
      apply(record, { type: "buildFailed", error: error instanceof PluginBuildError ? error.messages.join("\n") : String(error) })
    }
  }

  const enqueueBuild = (record: LivePluginRecord) => {
    record.queue = record.queue.then(() => runBuild(record))
    return record.queue
  }

  const startWatch = (record: LivePluginRecord) =>
    watchPluginFolder({
      rootDir: record.entry.directory,
      onChange: () => void enqueueBuild(record),
      onError: (error) => apply(record, { type: "buildFailed", error: `The folder watch failed: ${error.message}` }),
    })

  const entries = () => [...plugins.values()].map((record) => record.entry)

  const ready = (async () => {
    for (const entry of await readLivePluginRegistry(root)) {
      const last = await readCurrentLivePluginBundle(root, entry.id)
      const record: LivePluginRecord = { entry, name: last?.name ?? null, version: last?.version ?? null, state: initialLivePluginState(last), queue: Promise.resolve() }
      plugins.set(entry.id, record)
      record.watch = startWatch(record)
      void enqueueBuild(record)
    }
  })()

  return {
    ready,
    list: () => [...plugins.values()].map(row).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    async add(directory) {
      const real = await existingDirectory(directory)
      let manifest
      try {
        manifest = (await readPluginPackage(real)).manifest
      } catch (error) {
        if (error instanceof PluginBuildError) throw new LivePluginAddError(400, "live_plugin_manifest_invalid", error.messages.join("\n"))
        throw error
      }
      if (plugins.has(manifest.id)) throw new LivePluginAddError(409, "live_plugin_exists", `A plugin with id ${manifest.id} is already registered`)
      if (entries().some((entry) => entry.directory === real)) throw new LivePluginAddError(409, "live_plugin_directory_registered", `${real} is already registered`)
      const entry: LivePluginRegistryEntry = { id: manifest.id, directory: real, addedAt: new Date().toISOString() }
      const record: LivePluginRecord = { entry, name: manifest.name, version: manifest.version, state: initialLivePluginState(undefined), queue: Promise.resolve() }
      plugins.set(entry.id, record)
      await writeLivePluginRegistry(root, entries())
      await enqueueBuild(record)
      record.watch = startWatch(record)
      return row(record)
    },
    async remove(id) {
      const record = plugins.get(id)
      if (!record) return false
      record.watch?.close()
      plugins.delete(id)
      await writeLivePluginRegistry(root, entries())
      await record.queue
      await removeLivePluginBundles(root, id)
      publish({ type: "plugins.changed", pluginId: id, status: "removed", ts: Date.now() })
      return true
    },
    bundle: (id, hash) => readLivePluginBundle(root, id, hash),
    settled: async () => {
      await ready
      await Promise.all([...plugins.values()].map((record) => record.queue))
    },
    dispose() {
      for (const record of plugins.values()) record.watch?.close()
    },
  }
}

let instance: LivePluginService | undefined

export function livePluginService(): LivePluginService {
  instance ??= createLivePluginService({ root: path.join(dataDir(), "live-plugins"), publish: (event) => controlBus.publish(event) })
  return instance
}
