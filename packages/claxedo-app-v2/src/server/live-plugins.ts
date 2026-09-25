import type { LivePluginsApi } from "./api"
import { responseError, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { LivePlugin, LivePluginSource, LivePluginSourceText } from "./live-plugin-types"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import { parseLivePlugins, parseLivePluginSource, parseLivePluginSourceText } from "./wire/live-plugins"

const LIVE_PLUGINS_PATH = "/api/claxedo/live-plugins"

function pluginPath(pluginId: string) {
  return `${LIVE_PLUGINS_PATH}/${encodeURIComponent(pluginId)}`
}

export function livePluginQueries(transport: Transport) {
  const server = transport.serverUrl
  return {
    list: () => fetchQuery<readonly LivePlugin[]>(queryKeys.livePlugins(server), async () => parseLivePlugins(await transport.json<unknown>(LIVE_PLUGINS_PATH))),
    source: (pluginId: string) =>
      fetchQuery<LivePluginSource>(queryKeys.livePluginSource(server, pluginId), async () =>
        parseLivePluginSource(await transport.json<unknown>(`${pluginPath(pluginId)}/source`)),
      ),
    sourceFile: (pluginId: string, path: string) =>
      fetchQuery<LivePluginSourceText>(queryKeys.livePluginSourceFile(server, pluginId, path), async () =>
        parseLivePluginSourceText(await transport.json<unknown>(withQuery(`${pluginPath(pluginId)}/source/file`, { path }))),
      ),
  }
}

export function createLivePluginsApi(transport: Transport): LivePluginsApi {
  return {
    bundle: async (pluginId, hash) => {
      const response = await transport.request(`${pluginPath(pluginId)}/${encodeURIComponent(hash)}/app.js`, { headers: { Accept: "text/javascript" } })
      if (!response.ok) throw await responseError(response, `The bundle of ${pluginId}`)
      try {
        return await response.text()
      } catch (error) {
        throw toAppError(error)
      }
    },
    remove: async (pluginId) => {
      await transport.json<unknown>(pluginPath(pluginId), { method: "DELETE" })
    },
  }
}
