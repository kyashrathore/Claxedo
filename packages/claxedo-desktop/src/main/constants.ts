type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.CLAXEDO_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// electron-updater's GitHub provider fetches `${UPDATE_CHANNEL}.yml` (plus
// `-mac`/`-linux` variants) from the release. Stable keeps "latest" for its
// installed base; beta publishes under "beta", and the builder config's
// `publish.channel` stamps the matching feed into the packaged app-update.yml,
// so the variants can never poll each other's metadata.
export const UPDATE_CHANNEL: "latest" | "beta" = CHANNEL === "beta" ? "beta" : "latest"

export const SETTINGS_STORE = "claxedo.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const IS_PACKAGED = !process.defaultApp
export const UPDATER_ENABLED = IS_PACKAGED && CHANNEL !== "dev"
