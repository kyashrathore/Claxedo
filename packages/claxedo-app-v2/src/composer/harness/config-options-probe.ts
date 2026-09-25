import type { HarnessConfigApi } from "@/server"
import { createHarnessConnectionsCatalog } from "./connection-catalog"
import { harnessHasConfigOptions, type HarnessType } from "./profile"

/** Whether a harness answers config options: fixed for a native one, the connection catalog's word for a connection. */
export function createConfigOptionsProbe(api: HarnessConfigApi) {
  const connectionCatalog = createHarnessConnectionsCatalog({ api })
  let connectionRefresh: Promise<void> | undefined
  return async (type: HarnessType) => {
    if (type.kind === "native") return harnessHasConfigOptions(type)
    if (!connectionCatalog.data()) {
      connectionRefresh ??= connectionCatalog.refresh().finally(() => { connectionRefresh = undefined })
      await connectionRefresh
    }
    const catalog = connectionCatalog.data()
    if (catalog?.status === "unsupported") throw new Error(catalog.reason)
    const row = catalog?.connections.find((item) => item.connectionId === type.connectionId)
    if (!row) throw new Error(connectionCatalog.error() ?? `Connection ${type.connectionId} is unavailable`)
    return row.capabilities.configOptions
  }
}
