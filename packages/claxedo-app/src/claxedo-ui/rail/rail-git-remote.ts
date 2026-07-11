export function parseOwnerRepo(remote: string | undefined): string | undefined {
  if (!remote) return
  const ssh = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)
  if (ssh?.[1]) return ssh[1]
  return
}
