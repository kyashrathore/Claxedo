/**
 * Format CIDRs for Daytona SDK `networkAllowList` parameter.
 * Daytona currently accepts at most 10 entries.
 */
export function formatDaytonaAllowList(cidrs: string[]): string {
  return cidrs.slice(0, 10).join(",")
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
  return [...new Set(hosts)].join(",")
}
