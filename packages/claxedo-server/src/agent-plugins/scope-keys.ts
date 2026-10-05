/** The row scope an Agent Plugins choice or source belongs to: one person in an organization, or the organization itself. */
export function userScopeKey(orgId: string, userId: string) {
  return `${orgId}:user:${userId}`
}

export function organizationScopeKey(orgId: string) {
  return `${orgId}:organization`
}
