import path from "node:path"
import { asRecord } from "@claxedo/helpers/guards"
import { text } from "../shared/sdk-runtime-adapter"

/**
 * The Agent Plugins launch payload for Codex: a marketplace to register and the
 * plugin ids to install from it. Every field is rejected rather than coerced —
 * these become command-line arguments to the app-server, so an id that does not
 * belong to the named marketplace is refused here, not resolved there.
 */
export type CodexPluginLaunch = {
  marketplace: { name: string; source: string }
  plugins: string[]
}

export function codexPluginLaunch(launch: unknown): CodexPluginLaunch | undefined {
  const config = asRecord(asRecord(launch)?.config)
  if (!config || Object.keys(config).length === 0) return undefined
  const marketplace = asRecord(config.marketplace)
  const name = text(marketplace?.name)
  const source = text(marketplace?.source)
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error("Codex Agent Plugins launch config contains an invalid marketplace name")
  }
  if (!source || !path.isAbsolute(source)) {
    throw new Error("Codex Agent Plugins launch config contains an invalid marketplace source")
  }
  if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
    throw new Error("Codex Agent Plugins launch config contains no plugins")
  }
  const plugins = config.plugins.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]+@[A-Za-z0-9_-]+$/.test(value) || !value.endsWith(`@${name}`)) {
      throw new Error("Codex Agent Plugins launch config contains an invalid plugin id")
    }
    return value
  })
  if (new Set(plugins).size !== plugins.length) {
    throw new Error("Codex Agent Plugins launch config contains duplicate plugin ids")
  }
  return { marketplace: { name, source }, plugins }
}
