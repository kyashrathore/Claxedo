/**
 * Dependency-free repository identity shared by application-authority stores.
 *
 * The key deliberately ignores transport spelling while retaining the
 * case-sensitive repository path. A repository without a remote or directory
 * is still a real authority resource, so it receives an explicit
 * workspace-scoped key instead of an inferred URL.
 */
export function canonicalRepositoryUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
  const scp = trimmed.match(/^[^@/\s]+@([^:/\s]+):(.+)$/)
  if (scp) return `${String(scp[1]).toLowerCase()}/${scp[2]}`
  const parsed = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i)
  if (parsed) return `${String(parsed[1]).toLowerCase()}/${parsed[2]}`
  return trimmed
}

export function canonicalRepositoryKey(input: {
  repoKey?: string | null
  repoUrl?: string | null
  remoteDirectory?: string | null
  workspaceId: string
}) {
  if (input.repoKey) {
    const stored = input.repoKey.trim()
    if (stored.startsWith("workspace:")) return stored
    if (stored.startsWith("/") || /^[A-Za-z]:[\\/]/.test(stored)) return canonicalDirectory(stored)
    return canonicalRepositoryUrl(stored)
  }
  if (input.repoUrl) return canonicalRepositoryUrl(input.repoUrl)
  if (input.remoteDirectory) return canonicalDirectory(input.remoteDirectory)
  return `workspace:${input.workspaceId}`
}

function canonicalDirectory(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}
