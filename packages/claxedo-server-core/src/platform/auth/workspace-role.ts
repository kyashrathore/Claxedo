export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner"

const roleRank: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
}

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole) {
  return roleRank[actual] >= roleRank[required]
}
