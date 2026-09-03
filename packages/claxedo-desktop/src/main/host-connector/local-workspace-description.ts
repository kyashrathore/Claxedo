/**
 * What this machine knows about one of its own workspaces, as the control
 * plane's host assignment records it: the directory the runtime mounts, the
 * repository, the branch, and a name. The daemon is the owner of that truth
 * (`/api/claxedo/workspace`); the renderer only names WHICH workspace to
 * share, so the description is read here, in main, at share time.
 */
export type LocalWorkspaceDescription = {
  displayName: string
  directory: string
  repoName?: string
  gitBranch?: string
  repoUrl?: string
}

type DaemonWorkspace = {
  workspaceId?: unknown
  directory?: unknown
  workspaceName?: unknown
  backing?: { repoName?: unknown; branch?: unknown; repoUrl?: unknown } | null
}

export async function describeLocalWorkspace(
  daemonUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalWorkspaceDescription | undefined> {
  const response = await fetchImpl(new URL("/api/claxedo/workspace", daemonUrl))
  if (!response.ok) throw new Error(`workspace list answered ${response.status}`)
  const body = (await response.json()) as { workspaces?: unknown }
  const rows = Array.isArray(body.workspaces) ? (body.workspaces as DaemonWorkspace[]) : []
  const row = rows.find((item) => item.workspaceId === workspaceId)
  if (!row || typeof row.directory !== "string" || !row.directory) return undefined
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
  const repoName = text(row.backing?.repoName)
  const displayName = text(row.workspaceName) ?? repoName ?? row.directory.split("/").filter(Boolean).at(-1) ?? row.directory
  return {
    displayName,
    directory: row.directory,
    ...(repoName ? { repoName } : {}),
    ...(text(row.backing?.branch) ? { gitBranch: text(row.backing?.branch) } : {}),
    ...(text(row.backing?.repoUrl) ? { repoUrl: text(row.backing?.repoUrl) } : {}),
  }
}
