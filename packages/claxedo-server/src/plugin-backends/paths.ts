export const APP_PLUGINS_ROUTE_PREFIX = "/api/claxedo/app-plugins"

/**
 * A plugin's public link, `GET <prefix>/<token>`, which anyone holding the
 * token reads without signing in. Documents still owns `/p` until its cutover
 * (P8b), so links live here.
 */
export const APP_PLUGIN_LINK_ROUTE = `${APP_PLUGINS_ROUTE_PREFIX}/links`
