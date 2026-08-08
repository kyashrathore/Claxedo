import { setExtensions, appExtensions, serverExtensions } from "../../features/extensions/index"
import { initializeClerk } from "@/platform/auth/auth-client"
import { DEFAULT_LOCAL_CLAXEDO_SERVER_URL } from "@/platform/api/local-server"
import { optionalFeatureFlags } from "@/app/integrations/optional-feature-flags"

export interface ClaxedoConfig {
  convexUrl: string
  authBaseUrl: string
  gatewayUrl: string
  cloudAutoSwitch?: boolean
  authEnabled?: boolean
  sandboxEnabled?: boolean
  globalChatEnabled?: boolean
  documentsEnabled?: boolean
  workgraphEnabled?: boolean
  daytonaApiKey?: string
  claxedoServerUrl?: string
}

export function initClaxedo(config: ClaxedoConfig): void {
  setExtensions({
    app: appExtensions(config),
    server: serverExtensions(config),
  })

  if (config.authEnabled) initializeClerk().catch(() => {})
}

export function getDefaultConfig(): ClaxedoConfig {
  const envString = (value: unknown) => (typeof value === "string" ? value : undefined)
  const optionalFeatures = optionalFeatureFlags()

  return {
    convexUrl: import.meta.env.VITE_CONVEX_URL ?? "",
    authBaseUrl: envString(import.meta.env.VITE_AUTH_BASE_URL) ?? window.location.origin,
    gatewayUrl: envString(import.meta.env.VITE_OPENCODE_BACKEND_URL) ?? "http://127.0.0.1:3000",
    cloudAutoSwitch: import.meta.env.VITE_CLOUD_AUTOSWITCH !== "false",
    authEnabled: import.meta.env.VITE_AUTH_ENABLED === "true",
    sandboxEnabled: true,
    globalChatEnabled: import.meta.env.VITE_GLOBAL_CHAT_ENABLED === "true",
    documentsEnabled: optionalFeatures.documents,
    workgraphEnabled: optionalFeatures.workgraph,
    daytonaApiKey: envString(import.meta.env.VITE_DAYTONA_API_KEY),
    claxedoServerUrl: envString(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? DEFAULT_LOCAL_CLAXEDO_SERVER_URL,
  }
}
