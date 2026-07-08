/**
 * Format CIDRs for Daytona SDK `networkAllowList` parameter.
 * Daytona currently accepts at most 10 entries.
 */
export function formatDaytonaAllowList(cidrs: string[]): string {
  return cidrs.slice(0, 10).join(",")
}
