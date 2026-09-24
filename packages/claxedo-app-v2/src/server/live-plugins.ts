import type { LivePluginsApi } from "./api"
import type { Transport } from "./transport"

const LIVE_PLUGINS_PATH = "/api/claxedo/live-plugins"

export function createLivePluginsApi(transport: Transport): LivePluginsApi {
  return {
    remove: async (pluginId) => {
      await transport.json<unknown>(`${LIVE_PLUGINS_PATH}/${encodeURIComponent(pluginId)}`, { method: "DELETE" })
    },
  }
}
