/**
 * What this machine knows about one of its own workspaces, as the control
 * plane's host assignment records it: the directory the runtime mounts, the
 * repository, the branch, and a name. The daemon is the owner of that truth;
 * the renderer only names WHICH workspace to share, so the description is read
 * here, in main, at share time.
 *
 * Read from the RESOLVE route, which answers one workspace by id and is the
 * only projection that carries the repository fields below. The daemon's list
 * verb answers the control-plane list contract, whose `backing` is a bare word
 * with no repository in it.
 */

import { readRecord, readString } from "../../shared/json-read"
import type { DaemonFetch } from "../daemon-request"

export type LocalWorkspaceDescription = {
  displayName: string
  directory: string
  repoName?: string
  gitBranch?: string
  repoUrl?: string
}

export async function describeLocalWorkspace(
  daemon: DaemonFetch,
  workspaceId: string,
): Promise<LocalWorkspaceDescription | undefined> {
  const path = `/api/claxedo/workspace/resolve?workspaceId=${encodeURIComponent(workspaceId)}`
  const response = await daemon(path)
  // A workspace this machine does not hold is not an error to share against —
  // the caller decides what an undescribed workspace means.
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`workspace resolve answered ${response.status}`)
  const row: unknown = await response.json()
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
