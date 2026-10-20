import type { LivePlugin } from "@/server"
import type { PluginHost } from "../host"
import { liveOriginOf, type PluginBuild } from "../model"
import { failingBuild, type LiveRow } from "./load"

export type LiveReconciler = { readonly reconcile: (rows: readonly LivePlugin[]) => void }

function servedHash(row: LivePlugin): string | undefined {
  if (row.hash) return row.hash
  return row.status === "failed" ? `unbuilt:${row.lastError ?? ""}` : undefined
}

function liveLoadKey(row: LivePlugin, hash: string): string {
  return `${hash}\n${row.lastError ?? ""}`
}

export function createLiveReconciler(host: PluginHost, loadBuild: (row: LiveRow) => Promise<PluginBuild>): LiveReconciler {
  const requested = new Map<string, string>()

  const load = async (row: LivePlugin, hash: string) => {
    const loadKey = liveLoadKey(row, hash)
    requested.set(row.id, loadKey)
    const build = row.hash ? await loadBuild({ ...row, hash: row.hash }) : failingBuild(row, hash, new Error(row.lastError ?? row.status))
    if (requested.get(row.id) === loadKey) host.put(build)
  }

  return {
    reconcile: (rows) => {
      const listed = new Set(rows.map((row) => row.id))
      for (const plugin of host.plugins()) {
        const { id } = plugin
        if (!liveOriginOf(plugin) || listed.has(id)) continue
        requested.delete(id)
        host.drop(id)
      }
      for (const row of rows) {
        const hash = servedHash(row)
        if (!hash) continue
        const current = host.plugins().find((plugin) => plugin.id === row.id)
        const origin = current && liveOriginOf(current)
        const loaded = origin?.hash === hash
        if (loaded && origin.buildError === (row.lastError ?? undefined)) continue
        if (requested.get(row.id) === liveLoadKey(row, hash) && !loaded) continue
        void load(row, hash)
      }
    },
  }
}
