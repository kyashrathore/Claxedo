import type { LivePlugin } from "../api"
import type { PluginHost } from "../host"
import type { PluginBuild } from "../model"
import { failingBuild, type LiveRow } from "./load"

export type LiveReconciler = { readonly reconcile: (rows: readonly LivePlugin[]) => void }

function servedHash(row: LivePlugin): string | undefined {
  if (row.hash) return row.hash
  return row.status === "failed" ? `unbuilt:${row.lastError ?? ""}` : undefined
}

export function createLiveReconciler(host: PluginHost, loadBuild: (row: LiveRow) => Promise<PluginBuild>): LiveReconciler {
  const requested = new Map<string, string>()

  const load = async (row: LivePlugin, hash: string) => {
    requested.set(row.id, hash)
    const build = row.hash ? await loadBuild({ ...row, hash: row.hash }) : failingBuild(row, hash, new Error(row.lastError ?? row.status))
    if (requested.get(row.id) === hash) host.put(build)
  }

  const liveIds = () => host.plugins().flatMap((plugin) => (plugin.origin.kind === "live" ? [plugin.id] : []))

  return {
    reconcile: (rows) => {
      const listed = new Set(rows.map((row) => row.id))
      for (const id of liveIds()) {
        if (listed.has(id)) continue
        requested.delete(id)
        host.drop(id)
      }
      for (const row of rows) {
        const hash = servedHash(row)
        if (!hash) continue
        const current = host.plugins().find((plugin) => plugin.id === row.id)
        const loaded = current?.origin.kind === "live" && current.origin.hash === hash
        if (loaded && current.origin.kind === "live" && current.origin.buildError === (row.lastError ?? undefined)) continue
        if (requested.get(row.id) === hash && !loaded) continue
        void load(row, hash)
      }
    },
  }
}
