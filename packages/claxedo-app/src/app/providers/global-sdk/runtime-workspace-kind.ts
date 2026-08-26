export const USER_HOSTED_WORKSPACE_KIND = "user-hosted"

export function runtimeWorkspaceKind(input: unknown) {
  if (input === "local" || input === "cloud" || input === USER_HOSTED_WORKSPACE_KIND) return input
}
