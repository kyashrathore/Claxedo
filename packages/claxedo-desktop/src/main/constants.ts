type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.CLAXEDO_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "claxedo.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const IS_PACKAGED = !process.defaultApp
export const UPDATER_ENABLED = IS_PACKAGED && CHANNEL !== "dev"
