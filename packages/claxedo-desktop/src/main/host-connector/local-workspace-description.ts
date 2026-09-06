/**
 * What this machine knows about one of its own workspaces, as the control
 * plane's host assignment records it: the directory the runtime mounts, the
 * repository, the branch, and a name. The daemon is the owner of that truth
 * (`/api/claxedo/workspace`); the renderer only names WHICH workspace to
 * share, so the description is read here, in main, at share time.
 */

import { readArray, readRecord, readString } from "../../shared/json-read"

export type LocalWorkspaceDescription = {
  displayName: string
  directory: string
  repoName?: string
  gitBranch?: string
  repoUrl?: string
}

export async function describeLocalWorkspace(
  daemonUrl: string,
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalWorkspaceDescription | undefined> {
  const response = await fetchImpl(new URL("/api/claxedo/workspace", daemonUrl))
  if (!response.ok) throw new Error(`workspace list answered ${response.status}`)
  const body: unknown = await response.json()
  const row = readArray(body, "workspaces")?.find((item) => readString(item, "workspaceId") === workspaceId)
  const directory = readString(row, "directory")
  if (!directory) return undefined
  const trimmed = (value: string | undefined) => (value?.trim() ? value.trim() : undefined)
  const backing = readRecord(row, "backing")
  const repoName = trimmed(readString(backing, "repoName"))
  const gitBranch = trimmed(readString(backing, "branch"))
  const repoUrl = trimmed(readString(backing, "repoUrl"))
  const displayName =
    trimmed(readString(row, "workspaceName")) ?? repoName ?? directory.split("/").filter(Boolean).at(-1) ?? directory
  return {
    displayName,
    directory,
    ...(repoName ? { repoName } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(repoUrl ? { repoUrl } : {}),
  }
}
