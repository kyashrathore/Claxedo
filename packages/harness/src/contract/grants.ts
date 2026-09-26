export const BROKER_GRANTS_KEY = "brokerGrants"

export function namespacedGrantKey(connectionId: string, grantKey: string): string {
  return JSON.stringify([connectionId, grantKey])
}

export function connectionGrantKeys(permissionState: Record<string, unknown> | undefined, connectionId: string): string[] {
  const grants = permissionState?.[BROKER_GRANTS_KEY]
  if (grants === undefined) return []
  if (!Array.isArray(grants) || grants.some((grant) => typeof grant !== "string")) throw new Error("Invalid broker grants")
  return grants.flatMap((grant: string) => {
    const parsed: unknown = JSON.parse(grant)
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      throw new Error("Invalid broker grant key")
    }
    return parsed[0] === connectionId ? [parsed[1]] : []
  })
}
