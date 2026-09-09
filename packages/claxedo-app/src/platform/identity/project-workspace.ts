/**
 * The catalog row a workspace REF names, whichever identity the ref carries.
 *
 * One workspace is reachable under several. A relay-backed workspace is keyed
 * — and addressed — by `workspace:<id>`, the same form `sessionRowDirectory`
 * stamps on its session rows; a local one by its filesystem path. Either row
 * also carries `id`/`workspaceId`, and callers hold refs in all of those
 * shapes. All of them name one row, so one lookup answers for all of them; a
 * ref that resolves to nothing loses the workspace's kind, role and id, and
 * the caller then treats a relay-backed session as a local one.
 */
export function projectWorkspaceForRef<
  TWorkspace extends { id?: string | null; workspaceId?: string | null; directory?: string | null },
>(workspaces: Record<string, TWorkspace> | undefined, ref: string | undefined): TWorkspace | undefined {
  if (ref === undefined) return undefined
  const keyed = workspaces?.[ref]
  if (keyed) return keyed
  const workspaceId = ref?.startsWith(WORKSPACE_REF_PREFIX) ? ref.slice(WORKSPACE_REF_PREFIX.length) : undefined
  return Object.values(workspaces ?? {}).find((workspace) =>
    workspace.directory === ref ||
    workspace.id === ref ||
    workspace.workspaceId === ref ||
    (workspaceId !== undefined && (workspace.id === workspaceId || workspace.workspaceId === workspaceId))
  )
}

const WORKSPACE_REF_PREFIX = "workspace:"

