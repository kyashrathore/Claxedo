import { createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useAccess } from "@/access"
import { useServer } from "@/server"
import { appPluginEntries, matchesAppPlugin } from "./model"

export function createAppPluginDirectory(query: () => string) {
  const server = useServer()
  const access = useAccess()
  const offered = server.queries.appPlugins.offered
  const reread = { enabled: offered, refetchOnMount: "always" as const }
  const installed = useQuery(() => ({ ...server.queries.appPlugins.installed(), ...reread }))
  const catalog = useQuery(() => ({ ...server.queries.appPlugins.catalog(), ...reread }))
  const entries = createMemo(() => appPluginEntries(installed.data ?? [], catalog.data))
  const visible = createMemo(() => entries().filter((entry) => matchesAppPlugin(entry, query().trim().toLowerCase())))
  return {
    offered,
    installed,
    catalog,
    entries,
    visible,
    canManage: () => access.can("appPlugins.manage", { canManageAppPlugins: catalog.data?.canManage }),
    find: (pluginId: string | undefined) => entries().find((entry) => entry.id === pluginId),
  }
}

export type AppPluginDirectory = ReturnType<typeof createAppPluginDirectory>
