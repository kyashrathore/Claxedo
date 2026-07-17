export const LOCAL_DOCUMENT_BROKER_TOKEN_ENV = "CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN"

const INTERNAL_SECRET_ENV = new Set([
  LOCAL_DOCUMENT_BROKER_TOKEN_ENV,
  "CLAXEDO_WR_RELAY_HOST_PUBLIC_KEY_JWK",
  "CLAXEDO_WR_RELAY_JWT_ALG",
  "CLAXEDO_RELAY_JWKS_URL",
  "CLAXEDO_RELAY_HOST_VERIFY_PEM",
  "WORKSPACE_RUNTIME_CONFIG_TOKEN",
  "CLAXEDO_WR_TRUSTED_DIRECT_TOKEN",
  "CLAXEDO_CONTROL_PLANE_URL",
  "CLAXEDO_CONTROL_PLANE_JWKS_URL",
].map((name) => process.platform === "win32" ? name.toUpperCase() : name))

export function harnessSpawnEnv(input: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([name, value]) => {
    if (value === undefined) return false
    return !INTERNAL_SECRET_ENV.has(process.platform === "win32" ? name.toUpperCase() : name)
  }))
}
