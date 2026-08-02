export const DEFAULT_CLAXEDO_REGIONS = ["apac-south", "apac-east", "eu-west", "us-east", "us-west"] as const

export type ClaxedoRegion = string
export type ClaxedoRegionMap<T> = Partial<Record<ClaxedoRegion, T>>

/**
 * Deployed region ids. CLAXEDO_REGIONS (comma-separated) overrides the hosted
 * default so self-hosted deployments can run their own region set; each region
 * still reads its relay endpoint from `CLAXEDO_WORKSPACE_RELAY_URL_<SUFFIX>`
 * (see `relayEndpointsFromEnv`).
 */
export function claxedoRegions(env: Record<string, string | undefined> = process.env): readonly ClaxedoRegion[] {
  const regions = (env.CLAXEDO_REGIONS ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  return regions.length ? regions : DEFAULT_CLAXEDO_REGIONS
}

export function normalizeClaxedoRegion(
  input: unknown,
  fallback: ClaxedoRegion = "us-east",
  env: Record<string, string | undefined> = process.env,
): ClaxedoRegion {
  if (typeof input !== "string") return fallback
  return claxedoRegions(env).includes(input) ? input : fallback
}

export function defaultHomeRegion(env: Record<string, string | undefined> = process.env): ClaxedoRegion {
  return normalizeClaxedoRegion(env.CLAXEDO_HOME_REGION, "us-east", env)
}

export function claxedoRegionEnvSuffix(region: ClaxedoRegion) {
  return region.toUpperCase().replaceAll("-", "_")
}

export function relayEndpointsFromEnv(env: Record<string, string | undefined>, fallback?: string): ClaxedoRegionMap<string> {
  return Object.fromEntries(
    claxedoRegions(env)
      .map((region) => {
        const value = env[`CLAXEDO_WORKSPACE_RELAY_URL_${claxedoRegionEnvSuffix(region)}`]?.trim() || fallback?.trim()
        return value ? [region, value] : undefined
      })
      .filter((item): item is [ClaxedoRegion, string] => !!item),
  )
}

export function regionValue<T>(values: ClaxedoRegionMap<T> | undefined, region: ClaxedoRegion): T | undefined {
  return values?.[region]
}
