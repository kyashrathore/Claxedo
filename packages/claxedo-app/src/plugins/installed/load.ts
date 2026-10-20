import type { EnabledAppPlugin } from "@/server"
import type { PluginServerCalls } from "../api"
import { throwingDefinition } from "../bundle"
import { frameDefinition } from "../frame/definition"
import type { FrameHost } from "../frame/open"
import type { PluginBuild, PluginOrigin } from "../model"
import { verifiedBundleText } from "./verify"

function originOf(plugin: EnabledAppPlugin): PluginOrigin {
  return { kind: "installed", hash: plugin.appSha256, version: plugin.version }
}

export async function loadInstalledBuild(plugin: EnabledAppPlugin, calls: Pick<PluginServerCalls, "installedBundle">, frame: FrameHost): Promise<PluginBuild> {
  const build = { manifest: plugin.manifest, origin: originOf(plugin) }
  try {
    const code = await verifiedBundleText(plugin.id, await calls.installedBundle(plugin.id, plugin.appSha256), plugin.appSha256)
    return { ...build, definition: frameDefinition({ ...frame, code, backend: Boolean(plugin.manifest.backend) }) }
  } catch (error) {
    return { ...build, definition: throwingDefinition(error) }
  }
}
