import type { LivePluginsApi } from "./api"
import { responseError, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { LivePlugin } from "./live-plugin-types"
import { queryKeys } from "./query-keys"
import type { Transport } from "./transport"
import { parseLivePlugins } from "./wire/live-plugins"

const LIVE_PLUGINS_PATH = "/api/claxedo/live-plugins"

function livePluginPath(pluginId: string) {
  return `${LIVE_PLUGINS_PATH}/${encodeURIComponent(pluginId)}`
}

export function livePluginQueries(transport: Transport) {
  const server = transport.serverUrl
  return {
    list: () => fetchQuery<readonly LivePlugin[]>(queryKeys.livePlugins(server), async () => parseLivePlugins(await transport.json(LIVE_PLUGINS_PATH))),
  }
}

export function createLivePluginsApi(transport: Transport): LivePluginsApi {
  return {
    bundle: async (pluginId, hash) => {
      const response = await transport.request(`${livePluginPath(pluginId)}/${encodeURIComponent(hash)}/app.js`, { headers: { Accept: "text/javascript" } })
      if (!response.ok) throw await responseError(response, `The bundle of ${pluginId}`)
      try {
        return await response.text()
      } catch (error) {
        throw toAppError(error)
      }
    },
    remove: async (pluginId) => {
      await transport.json(livePluginPath(pluginId), { method: "DELETE" })
    },
  }
}
