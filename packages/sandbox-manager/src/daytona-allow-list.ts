// Every entry below becomes part of ONE comma-delimited provider parameter.
// An entry that itself carries a delimiter — or is not a legal hostname/IP/CIDR
// at all — would splice additional allowances into the allowlist the provider
// applies, so entries are validated before they are joined, not after.

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const HOST_ENTRY = new RegExp(`^(?:\\*\\.)?${HOST_LABEL}(?:\\.${HOST_LABEL})*$`, "i")
const CIDR_ENTRY = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/

function legalCidrEntry(entry: string) {
  if (!CIDR_ENTRY.test(entry)) return false
  const [address, mask] = entry.split("/")
  if (Number(mask) > 32) return false
  return address.split(".").every((octet) => Number(octet) <= 255)
}

/**
 * Format CIDRs for Daytona SDK `networkAllowList` parameter.
 * Daytona currently accepts at most 10 entries.
 */
export function formatDaytonaAllowList(cidrs: string[]): string {
  const entries = cidrs.slice(0, 10)
  for (const entry of entries) {
    if (!legalCidrEntry(entry)) {
      throw new Error(`daytona networkAllowList entry is not a legal IPv4 CIDR: ${JSON.stringify(entry)}`)
    }
  }
  return entries.join(",")
}

/**
 * Format hostnames for Daytona SDK `domainAllowList` parameter.
 *
 * Deliberately does NOT truncate, unlike the CIDR formatter above. Silently
 * dropping entries from an egress allowlist is the worst of both worlds: the
 * sandbox stays contained, but it loses reachability the caller believed it
 * granted and nothing anywhere says so. Daytona documents no cap on
 * `domainAllowList`; if one exists, an over-long list fails the create call
 * loudly, which is the outcome we want.
 */
export function formatDaytonaDomainAllowList(hosts: string[]): string {
  const entries = [...new Set(hosts)]
  for (const entry of entries) {
    if (!HOST_ENTRY.test(entry)) {
      throw new Error(`daytona domainAllowList entry is not a legal hostname or IP: ${JSON.stringify(entry)}`)
    }
  }
  return entries.join(",")
}
